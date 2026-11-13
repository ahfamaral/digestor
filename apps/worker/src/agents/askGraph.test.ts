import { INTERRUPT, MemorySaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OWNER_ID, findBoundaries, snapRange, type AskToolCallRecord, type ToolApprovalPayload, type ToolApprovalResolution, type Word } from "@digestor/core";
import {
  addAskMessage, completeAnalysisVersion, createClip, createDb, createSession, getAskMessage, listAskMessages, listClips, listPersonalMoments,
  listSelections, resolveToolApproval, saveMoments, saveTopics, saveTranscript, startAnalysisVersion, updateSession, type Db,
} from "@digestor/core/server";
import { handleAskResume } from "../jobs.js";
import { FakeToolLLM, type ToolCallRequest, type ToolMessage, type ToolStepCall } from "../llm/tools.js";
import type { SearchHit } from "../search/index.js";
import { ASK_CANT_CONTINUE, ASK_FAILED, DECLINED, MUTATING_TOOLS, resumeAsk, runAsk, type AskDeps } from "./ask.js";

/** 20 minutes of speech: 500 ms per word, sentences of 5 words (2.5 s), speaker A then B every other minute. */
const DURATION_MS = 20 * 60_000;
const words: Word[] = Array.from({ length: DURATION_MS / 500 }, (_, i) => ({
  text: i % 5 === 4 ? `word${i}.` : `word${i}`,
  startMs: i * 500,
  endMs: i * 500 + 400,
  confidence: 0.9,
  speaker: Math.floor(i / 120) % 2 === 0 ? "A" : "B",
}));
const snapped = (startMs: number, endMs: number) => snapRange(findBoundaries(words, DURATION_MS), { startMs, endMs });

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());

async function seed() {
  const s = await createSession(db, { title: "Interview", source: "upload" });
  await updateSession(db, s.id, { language: "en", durationMs: DURATION_MS, stage: "ready" });
  await saveTranscript(db, s.id, { language: "en", languageConfidence: 1, durationMs: DURATION_MS, words });
  const v = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "initial", models: {}, promptVersions: {} });
  const [topic] = await saveTopics(db, v.id, [{ idx: 0, startMs: 0, endMs: DURATION_MS, title: "Housing", summary: "Rents." }]);
  const moments = await saveMoments(
    db,
    v.id,
    Array.from({ length: 5 }, (_, i) => ({
      topicId: topic!.id,
      granularity: "passage" as const,
      startMs: i * 60_000,
      endMs: i * 60_000 + 30_000,
      title: `Moment ${i}`,
      why: "Why: a claim.",
      relevance: 50 + i,
      speakers: ["A"],
      evidence: [],
      origin: "ai" as const,
      highlights: [],
    })),
  );
  await completeAnalysisVersion(db, v.id);
  return { s, analysisId: v.id, momentIds: moments.map((m) => m.id) };
}

async function ask(sessionId: string, question: string) {
  await addAskMessage(db, { sessionId, ownerId: OWNER_ID, role: "user", text: question });
  return addAskMessage(db, { sessionId, ownerId: OWNER_ID, role: "assistant", text: "", status: "pending" });
}

const call = (name: string, args: unknown, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): ToolCallRequest => ({ id, name, args });
const toolStep = (...toolCalls: ToolCallRequest[]) => ({ text: "", toolCalls });
const answer = (text: string) => ({ text, toolCalls: [] });
const toolResults = (c: ToolStepCall): string[] => {
  const out: string[] = [];
  for (let i = c.messages.length - 1; i >= 0 && c.messages[i]!.role === "tool"; i--) {
    out.unshift((c.messages[i] as Extract<ToolMessage, { role: "tool" }>).content);
  }
  return out;
};

/**
 * A MemorySaver that can lose the interrupt (as a crash between storing the card and writing the checkpoint would)
 * and fail its reads (a database error before the resume claims the answer).
 */
class FlakySaver extends MemorySaver {
  dropInterrupts = false;
  failReads = false;
  override async putWrites(config: RunnableConfig, writes: [string, unknown][], taskId: string): Promise<void> {
    return super.putWrites(config, this.dropInterrupts ? writes.filter(([channel]) => channel !== INTERRUPT) : writes, taskId);
  }
  override async getTuple(config: RunnableConfig) {
    if (this.failReads) throw new Error("connection reset");
    return super.getTuple(config);
  }
}

const noSearch = async (): Promise<SearchHit[]> => [];
const depsFor = (llm: FakeToolLLM, checkpointer = new MemorySaver(), search: AskDeps["search"] = noSearch) => ({ db, llm, search, checkpointer });
const threadOf = (saver: MemorySaver, messageId: string) => saver.getTuple({ configurable: { thread_id: messageId } });

async function approvals(sessionId: string, messageId: string) {
  return (await listAskMessages(db, OWNER_ID, sessionId)).find((m) => m.id === messageId)!.actions.filter((a) => a.kind === "tool_approval");
}

/** Decides the answer's pending approval and resumes it, as the web route and the `ask.resume` job do. */
async function decide(deps: ReturnType<typeof depsFor>, sessionId: string, messageId: string, resolution: ToolApprovalResolution) {
  const pending = (await approvals(sessionId, messageId)).find((a) => a.status === "pending");
  if (!pending) throw new Error("no pending approval");
  expect(await resolveToolApproval(db, pending.id, resolution)).toBe(true);
  await resumeAsk(deps, pending.id);
  return pending;
}

describe("Ask graph", () => {
  it("MUTATING_TOOLS are the three tools that change clips or selections", () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(["propose_clip", "set_selection", "trim_clip"]);
  });

  it("a read-only turn answers without a pause, with the same records as before", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "What about rents?");
    const hit: SearchHit = { startMs: 60_000, endMs: 70_000, speakers: ["A"], text: "Rents rose.", score: 0.9 };
    const llm = new FakeToolLLM([toolStep(call("search_transcript", { query: "rents" })), answer("Rents rose [00:01:00].")]);
    const deps = depsFor(llm, new MemorySaver(), async () => [hit]);
    await runAsk(deps, msg.id);
    const done = (await getAskMessage(db, msg.id))!;
    expect(done).toMatchObject({ status: "done", text: "Rents rose [00:01:00]." });
    expect(done.toolCalls).toEqual([
      { name: "search_transcript", args: { query: "rents" }, result: expect.stringContaining("Rents rose."), ok: true },
    ]);
    expect(await approvals(s.id, msg.id)).toEqual([]);
    expect(await threadOf(deps.checkpointer, msg.id)).toBeUndefined(); // done: thread deleted
  });

  it("a turn calling propose_clip pauses: waiting, one pending tool_approval with the snapped change, no clip", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip the rent part.");
    const c = call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "Rent caps" }, "call-1");
    const llm = new FakeToolLLM([toolStep(c, call("list_topics", {}, "call-2")), answer("Made it [00:01:00].")]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    const [action, ...more] = await approvals(s.id, msg.id);
    expect(more).toEqual([]);
    const range = snapped(61_000, 91_000);
    const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);
    expect(action).toMatchObject({ status: "pending", resolution: null });
    expect(action!.payload).toEqual({
      step: 1,
      calls: [{ id: "call-1", name: "propose_clip", args: c.args, summary: `Make a clip ${fmt(range.startMs)}–${fmt(range.endMs)} 'Rent caps'`, range }],
    } satisfies ToolApprovalPayload);
    expect(await listClips(db, OWNER_ID, s.id)).toEqual([]);
    expect(llm.calls).toHaveLength(1); // the read-only call of the same turn waits too
    expect(await threadOf(deps.checkpointer, msg.id)).toBeDefined();
  });

  it("approve creates the clip, the answer finishes done and the thread is deleted", async () => {
    const { s, analysisId } = await seed();
    const msg = await ask(s.id, "Clip the rent part.");
    const llm = new FakeToolLLM([
      toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "Rent caps" }), call("list_topics", {})),
      answer("Made it [00:01:00]."),
    ]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const action = await decide(deps, s.id, msg.id, { decision: "approve" });

    const [clip] = await listClips(db, OWNER_ID, s.id);
    expect(clip).toMatchObject(snapped(61_000, 91_000));
    expect((await listPersonalMoments(db, OWNER_ID, analysisId))[0]).toMatchObject({ title: "Rent caps", origin: "ask" });
    const results = toolResults(llm.calls[1]!);
    expect(results[0]).toContain(clip!.id);
    expect(results[1]).toContain("Housing");
    const done = (await getAskMessage(db, msg.id))!;
    expect(done).toMatchObject({ status: "done", text: "Made it [00:01:00]." });
    expect((done.toolCalls as AskToolCallRecord[]).map((r) => [r.name, r.ok, r.clipId])).toEqual([
      ["propose_clip", true, clip!.id],
      ["list_topics", true, undefined],
    ]);
    expect((await approvals(s.id, msg.id))[0]).toMatchObject({ id: action.id, status: "confirmed", resolution: { decision: "approve" } });
    expect(await threadOf(deps.checkpointer, msg.id)).toBeUndefined();
  });

  it("edit uses the edited start and end (snapped) and title", async () => {
    const { s, analysisId } = await seed();
    const msg = await ask(s.id, "Clip the rent part.");
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "Rent caps" }, "c1")), answer("Done.")]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    await decide(deps, s.id, msg.id, { decision: "edit", edits: [{ id: "c1", args: { start: "00:02:01", end: "00:02:41", title: "Rents, edited" } }] });
    const [clip] = await listClips(db, OWNER_ID, s.id);
    expect(clip).toMatchObject(snapped(121_000, 161_000));
    expect((await listPersonalMoments(db, OWNER_ID, analysisId))[0]!.title).toBe("Rents, edited");
    expect(toolResults(llm.calls[1]!)[0]).toMatch(/The user edited this change before approving it\.$/);
    const [rec] = (await getAskMessage(db, msg.id))!.toolCalls as AskToolCallRecord[];
    expect(rec!.args).toEqual({ start: "00:02:01", end: "00:02:41", title: "Rents, edited" }); // the chip shows what was done
  });

  it("an edit that makes the change invalid is validated as usual: the model reads the error, nothing changes", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" }, "c1")), answer("Couldn't.")]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    await decide(deps, s.id, msg.id, { decision: "edit", edits: [{ id: "c1", args: { start: "00:01:01", end: "00:01:02" } }] });
    expect(toolResults(llm.calls[1]!)[0]).toMatch(/^Error: After snapping/);
    expect(await listClips(db, OWNER_ID, s.id)).toEqual([]);
    expect((await getAskMessage(db, msg.id))!.status).toBe("done");
  });

  it("reject creates nothing and the model reads 'The user declined this change.'", async () => {
    const { s, momentIds } = await seed();
    const msg = await ask(s.id, "Clip it and approve the first moment.");
    const llm = new FakeToolLLM([
      toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" }), call("set_selection", { momentIds: [momentIds[0]], status: "approved" }), call("list_topics", {})),
      answer("Fine, nothing changed."),
    ]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const [action] = await approvals(s.id, msg.id);
    expect((action!.payload as ToolApprovalPayload).calls.map((c) => [c.name, c.summary])).toEqual([
      ["propose_clip", expect.stringMatching(/^Make a clip /)],
      ["set_selection", "Approve 1 moment: 'Moment 0'"],
    ]);
    expect((action!.payload as ToolApprovalPayload).calls[1]!.moments).toEqual([{ id: momentIds[0], title: "Moment 0", startMs: 0, endMs: 30_000 }]);
    await decide(deps, s.id, msg.id, { decision: "reject" });
    expect(await listClips(db, OWNER_ID, s.id)).toEqual([]);
    expect(await listSelections(db, OWNER_ID, s.id)).toEqual({});
    const [clipResult, selResult, topics] = toolResults(llm.calls[1]!);
    expect(clipResult).toBe(DECLINED);
    expect(selResult).toBe(DECLINED);
    expect(topics).toContain("Housing"); // read-only calls of the turn still run
    expect((await approvals(s.id, msg.id))[0]).toMatchObject({ status: "dismissed", resolution: { decision: "reject" } });
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "done", text: "Fine, nothing changed." });
  });

  it("resuming the same action twice runs once (in turn and at the same time)", async () => {
    const { s } = await seed();
    for (const parallel of [false, true]) {
      const msg = await ask(s.id, "Clip it.");
      const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })), answer("Done.")]);
      const deps = depsFor(llm);
      await runAsk(deps, msg.id);
      const [action] = await approvals(s.id, msg.id);
      await resolveToolApproval(db, action!.id, { decision: "approve" });
      if (parallel) await Promise.all([resumeAsk(deps, action!.id), resumeAsk(deps, action!.id)]);
      else {
        await resumeAsk(deps, action!.id);
        await resumeAsk(deps, action!.id);
      }
      expect(llm.calls).toHaveLength(2);
      expect((await getAskMessage(db, msg.id))!.status).toBe("done");
    }
    expect(await listClips(db, OWNER_ID, s.id)).toHaveLength(2); // one per question
  });

  it("an action that is still pending, or of another kind, resumes nothing", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })), answer("Done.")]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const [action] = await approvals(s.id, msg.id);
    await resumeAsk(deps, action!.id);
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    expect(llm.calls).toHaveLength(1);
  });

  it("the R31 cap holds across approved changes: a 4th change is refused without asking, more selections become a bulk confirm", async () => {
    const { s, momentIds } = await seed();
    const msg = await ask(s.id, "Three clips, then one more, then approve a moment.");
    const llm = new FakeToolLLM([
      toolStep(
        call("propose_clip", { start: "00:01:00", end: "00:01:30", title: "One" }),
        call("propose_clip", { start: "00:03:00", end: "00:03:30", title: "Two" }),
        call("propose_clip", { start: "00:05:00", end: "00:05:30", title: "Three" }),
      ),
      toolStep(call("propose_clip", { start: "00:07:00", end: "00:07:30", title: "Four" }), call("set_selection", { momentIds: [momentIds[1]], status: "approved" })),
      answer("Three clips made; the rest needs your confirmation."),
    ]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    await decide(deps, s.id, msg.id, { decision: "approve" });
    expect(await listClips(db, OWNER_ID, s.id)).toHaveLength(3);
    const [fourth, sel] = toolResults(llm.calls[2]!);
    expect(fourth).toMatch(/^Error: .*confirm/i);
    expect(sel).toBe("Waiting for the user to confirm 1 changes.");
    const stored = (await listAskMessages(db, OWNER_ID, s.id)).find((m) => m.id === msg.id)!;
    expect(stored.actions.map((a) => [a.kind, a.status]).sort()).toEqual([
      ["bulk_selection", "pending"],
      ["tool_approval", "confirmed"],
    ]);
    expect(stored.status).toBe("done");
    expect((await listSelections(db, OWNER_ID, s.id))[momentIds[1]!]).toBeUndefined();
  });

  it("a change that can only fail is not put to the journalist: the model reads the error at once", async () => {
    const { s } = await seed();
    await updateSession(db, s.id, { videoDeletedAt: new Date() });
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:00:10", end: "00:00:40", title: "x" })), answer("No.")]);
    await runAsk(depsFor(llm), msg.id);
    expect(toolResults(llm.calls[1]!)[0]).toBe("Error: The video was removed after 14 days. Re-upload it to make new clips.");
    expect(await approvals(s.id, msg.id)).toEqual([]);
    expect((await getAskMessage(db, msg.id))!.status).toBe("done");
  });

  it("two approvals in one answer: each turn pauses once, and a stale resume of the first is ignored", async () => {
    const { s } = await seed();
    const existing = await createClip(db, { sessionId: s.id, ownerId: OWNER_ID, startMs: 600_000, endMs: 630_000, actor: "user" });
    const msg = await ask(s.id, "Clip it, then trim my clip.");
    const llm = new FakeToolLLM([
      toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })),
      toolStep(call("trim_clip", { clipId: existing.id, start: "00:10:05", end: "00:10:25" })),
      answer("Both done."),
    ]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const first = await decide(deps, s.id, msg.id, { decision: "approve" });
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    const second = (await approvals(s.id, msg.id)).find((a) => a.status === "pending")!;
    expect((second.payload as ToolApprovalPayload).step).toBe(2);
    expect((second.payload as ToolApprovalPayload).calls[0]!.summary).toMatch(/^Change the clip 00:10:00–00:10:30 to /);
    await resumeAsk(deps, first.id); // a redelivered job of the first decision
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    expect(llm.calls).toHaveLength(2);
    await decide(deps, s.id, msg.id, { decision: "approve" });
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "done", text: "Both done." });
  });
});

describe("handleAskResume", () => {
  const FIRST = { retryCount: 0, retryLimit: 2 };
  const LAST = { retryCount: 2, retryLimit: 2 };

  it("a card stored without its interrupt checkpoint (crash in between) still continues once decided", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const saver = new FlakySaver();
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })), answer("Done.")]);
    const deps = depsFor(llm, saver);
    saver.dropInterrupts = true;
    await runAsk(deps, msg.id);
    saver.dropInterrupts = false;
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    const stored = await (await import("./askGraph.js")).buildAskGraph(deps, saver).getState({ configurable: { thread_id: msg.id } });
    expect(stored.next).toEqual(["approve"]);
    expect(stored.tasks.flatMap((t) => t.interrupts)).toEqual([]); // the checkpoint holds no interrupt
    await decide(deps, s.id, msg.id, { decision: "approve" });
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "done", text: "Done." });
    expect(await listClips(db, OWNER_ID, s.id)).toHaveLength(1);
  });

  it("a resume that gives up before claiming fails the answer on the final attempt (its card is decided), not before", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const saver = new FlakySaver();
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })), answer("never")]);
    const deps = depsFor(llm, saver);
    await runAsk(deps, msg.id);
    const [action] = await approvals(s.id, msg.id);
    await resolveToolApproval(db, action!.id, { decision: "approve" });
    saver.failReads = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(handleAskResume(deps, { actionId: action!.id }, FIRST)).rejects.toThrow("connection reset");
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    await expect(handleAskResume(deps, { actionId: action!.id }, LAST)).rejects.toThrow("connection reset");
    err.mockRestore();
    saver.failReads = false;
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "failed", text: ASK_FAILED });
    expect(await threadOf(saver, msg.id)).toBeUndefined();
    expect(await listClips(db, OWNER_ID, s.id)).toEqual([]);
  });

  it("a paused answer whose thread is gone (retention) ends failed with a friendly line", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })), answer("Done.")]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    await deps.checkpointer.deleteThread(msg.id);
    const [action] = await approvals(s.id, msg.id);
    await resolveToolApproval(db, action!.id, { decision: "reject" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleAskResume(deps, { actionId: action!.id }, FIRST);
    err.mockRestore();
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "failed", text: ASK_CANT_CONTINUE });
    expect(llm.calls).toHaveLength(1);
  });

  it("a transient error before any change puts the answer back to waiting and rethrows; the retry continues", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([
      toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })),
      () => {
        throw new Error("529 overloaded");
      },
      answer("Fine, nothing made."),
    ]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const [action] = await approvals(s.id, msg.id);
    await resolveToolApproval(db, action!.id, { decision: "reject" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(handleAskResume(deps, { actionId: action!.id }, FIRST)).rejects.toThrow("529 overloaded");
    expect((await getAskMessage(db, msg.id))!.status).toBe("waiting");
    await handleAskResume(deps, { actionId: action!.id }, { retryCount: 1, retryLimit: 2 });
    err.mockRestore();
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "done", text: "Fine, nothing made." });
    expect(toolResults(llm.calls[2]!)).toEqual([DECLINED]); // the retry reran only the failed model turn
  });

  it("an error after an approved change fails at once, keeps the chip, deletes the thread", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([
      toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })),
      () => {
        throw new Error("socket hang up");
      },
    ]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const [action] = await approvals(s.id, msg.id);
    await resolveToolApproval(db, action!.id, { decision: "approve" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleAskResume(deps, { actionId: action!.id }, FIRST);
    err.mockRestore();
    const failed = (await getAskMessage(db, msg.id))!;
    expect(failed).toMatchObject({ status: "failed", text: ASK_FAILED });
    expect(failed.toolCalls).toEqual([expect.objectContaining({ name: "propose_clip", ok: true })]);
    expect(await listClips(db, OWNER_ID, s.id)).toHaveLength(1);
    expect(await threadOf(deps.checkpointer, msg.id)).toBeUndefined();
  });

  it("a retry that finds the resumed answer running (an attempt died) fails it instead of applying again", async () => {
    const { s } = await seed();
    const msg = await ask(s.id, "Clip it.");
    const llm = new FakeToolLLM([toolStep(call("propose_clip", { start: "00:01:01", end: "00:01:31", title: "x" })), answer("never")]);
    const deps = depsFor(llm);
    await runAsk(deps, msg.id);
    const [action] = await approvals(s.id, msg.id);
    await resolveToolApproval(db, action!.id, { decision: "approve" });
    const { claimWaitingAskMessage } = await import("@digestor/core/server");
    expect(await claimWaitingAskMessage(db, msg.id)).toBe(true); // the attempt that crashed
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleAskResume(deps, { actionId: action!.id }, { retryCount: 1, retryLimit: 2 });
    err.mockRestore();
    expect(await getAskMessage(db, msg.id)).toMatchObject({ status: "failed", text: ASK_FAILED });
    expect(await listClips(db, OWNER_ID, s.id)).toEqual([]);
  });
});
