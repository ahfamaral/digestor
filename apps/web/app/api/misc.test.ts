import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JOB_OPTIONS, OWNER_ID, QUEUES, VIDEO_REMOVED } from "@digestor/core";
import {
  createClip, createToolApproval, getAskAction, updateClip,
  completeAnalysisVersion, getRunningAnalysis, listAnalysisVersions, createAskAction, getAskMessage, listAskMessages, listProblemReports, listSelections, saveTranslation,
  startAnalysisVersion, createSession, updateSession, getTranslation, addAskMessage, getMoment, setMomentChecks, finishAskMessage,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { GET as getAsk, POST as postAsk } from "./sessions/[id]/ask/route";
import { POST as archiveAsk } from "./sessions/[id]/ask/archive/route";
import { POST as postAction } from "./ask-actions/[id]/route";
import { GET as getTranslationRoute, POST as postTranslation } from "./analyses/[id]/translations/route";
import { POST as reanalyze } from "./sessions/[id]/reanalyze/route";
import { POST as postReport } from "./reports/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => h.send.mockReset().mockImplementation(async () => "job-id"));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown, method = "POST") => new Request("http://localhost/x", { method, body: JSON.stringify(body) });
const cleanChecks = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};

describe("Ask", () => {
  it("ask creates a pending answer and one job", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const res = await postAsk(req({ question: "  Who spoke first? " }), ctx(sessionId));
    expect(res.status).toBe(202);
    const msgs = await listAskMessages(h.db, OWNER_ID, sessionId);
    expect(msgs.map((m) => [m.role, m.status, m.text])).toEqual([["user", "done", "Who spoke first?"], ["assistant", "pending", ""]]);
    expect(msgs[0]!.createdAt.getTime()).toBeLessThanOrEqual(msgs[1]!.createdAt.getTime());
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.ask, { messageId: msgs[1]!.id }, { ...JOB_OPTIONS, singletonKey: msgs[1]!.id });

    const list = await (await getAsk(new Request("http://localhost/x"), ctx(sessionId))).json();
    expect(list.messages).toHaveLength(2);
  });

  it("refuses bad questions and unready sessions; a failed enqueue rolls both rows back with 503", async () => {
    const { sessionId } = await seedReadySession(h.db);
    for (const question of ["", "   ", "x".repeat(501), 5]) expect((await postAsk(req({ question }), ctx(sessionId))).status).toBe(400);
    expect((await postAsk(req({ question: "x".repeat(500) }), ctx(sessionId))).status).toBe(202);
    h.send.mockRejectedValueOnce(new Error("boom"));
    const res = await postAsk(req({ question: "again?" }), ctx(sessionId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect(await listAskMessages(h.db, OWNER_ID, sessionId)).toHaveLength(2);
    await updateSession(h.db, sessionId, { stage: "finding_moments" });
    expect((await postAsk(req({ question: "hi" }), ctx(sessionId))).status).toBe(409);
    expect((await postAsk(req({ question: "hi" }), ctx("nope"))).status).toBe(404);
  });
});

describe("POST /api/sessions/[id]/ask/archive", () => {
  it("refuses while an answer is open, then archives; the list keeps the archived messages", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect(await (await archiveAsk(req({}), ctx(sessionId))).json()).toEqual({ archived: 0 });
    await postAsk(req({ question: "Topics?" }), ctx(sessionId));
    const busy = await archiveAsk(req({}), ctx(sessionId));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "Finish the open answer or card first: approve or reject it, then start a new conversation." });
    const [, answer] = await listAskMessages(h.db, OWNER_ID, sessionId);
    await finishAskMessage(h.db, answer!.id, { text: "Housing.", status: "done" });
    const ok = await archiveAsk(req({}), ctx(sessionId));
    expect(await ok.json()).toEqual({ archived: 2 });
    const list = await (await getAsk(new Request("http://localhost/x"), ctx(sessionId))).json();
    expect(list.messages.map((m: { archivedAt: string | null }) => m.archivedAt !== null)).toEqual([true, true]);
    expect((await archiveAsk(req({}), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });
});

describe("POST /api/ask-actions/[id]", () => {
  async function actionFor(status: "approved" | "rejected" | null, count = 2) {
    const { sessionId, moments } = await seedReadySession(h.db, [[10_000, 30_000], [40_000, 60_000], [70_000, 90_000]]);
    const msg = await addAskMessage(h.db, { sessionId, ownerId: OWNER_ID, role: "assistant", text: "Found some", status: "done" });
    const ids = moments.slice(0, count).map((m) => m.id);
    const action = await createAskAction(h.db, { messageId: msg.id, kind: "bulk_selection", payload: { momentIds: ids, status } });
    return { sessionId, moments, ids, action, msg };
  }

  it("confirming an action applies all selections once", async () => {
    const { sessionId, ids, action } = await actionFor("approved");
    const res = await postAction(req({ decision: "confirm" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed", applied: 2 });
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({ [ids[0]!]: "approved", [ids[1]!]: "approved" });
    // approving queues a check for moments without checks
    expect(h.send.mock.calls.filter((c) => c[0] === QUEUES.checkMoment)).toHaveLength(2);
    const second = await postAction(req({ decision: "confirm" }), ctx(action.id));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "This suggestion was already handled." });
  });

  it("confirms a pending action stored before the change with status neutral, as skipped", async () => {
    const { sessionId, ids, action } = await actionFor("neutral" as unknown as "rejected");
    expect((await postAction(req({ decision: "confirm" }), ctx(action.id))).status).toBe(200);
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({ [ids[0]!]: "rejected", [ids[1]!]: "rejected" });
  });

  it("two parallel confirms apply once (the loser gets 409)", async () => {
    const { action } = await actionFor("rejected");
    const [a, b] = await Promise.all([postAction(req({ decision: "confirm" }), ctx(action.id)), postAction(req({ decision: "confirm" }), ctx(action.id))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("status null sends the moments back to proposed", async () => {
    const { sessionId, ids, action } = await actionFor(null);
    const { setSelection } = await import("@digestor/core/server");
    for (const id of ids) await setSelection(h.db, OWNER_ID, id, "approved");
    expect((await postAction(req({ decision: "confirm" }), ctx(action.id))).status).toBe(200);
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({});
  });

  it("dismiss changes nothing else; a dismissed action can't be confirmed", async () => {
    const { sessionId, action } = await actionFor("approved");
    expect(await (await postAction(req({ decision: "dismiss" }), ctx(action.id))).json()).toEqual({ status: "dismissed" });
    expect((await postAction(req({ decision: "confirm" }), ctx(action.id))).status).toBe(409);
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({});
  });

  it("ignores moments of another video, refuses someone else's action and bad bodies", async () => {
    const { ids, action } = await actionFor("approved", 1);
    const other = await seedReadySession(h.db);
    const stray = await createAskAction(h.db, {
      messageId: action.messageId, kind: "bulk_selection", payload: { momentIds: [ids[0]!, other.moments[0]!.id], status: "approved" },
    });
    expect(await (await postAction(req({ decision: "confirm" }), ctx(stray.id))).json()).toEqual({ status: "confirmed", applied: 1 });
    expect(await listSelections(h.db, OWNER_ID, other.sessionId)).toEqual({});

    const foreign = await seedReadySession(h.db);
    const fmsg = await addAskMessage(h.db, { sessionId: foreign.sessionId, ownerId: "someone-else", role: "assistant", text: "x", status: "done" });
    const fa = await createAskAction(h.db, { messageId: fmsg.id, kind: "bulk_selection", payload: { momentIds: [], status: "approved" } });
    expect((await postAction(req({ decision: "confirm" }), ctx(fa.id))).status).toBe(404);
    expect((await postAction(req({ decision: "maybe" }), ctx(action.id))).status).toBe(400);
    expect((await postAction(req({ decision: "confirm" }), ctx("nope"))).status).toBe(404);
  });

  it("does not queue checks for moments that already have them", async () => {
    const { ids, action } = await actionFor("approved", 1);
    await setMomentChecks(h.db, ids[0]!, cleanChecks);
    await postAction(req({ decision: "confirm" }), ctx(action.id));
    expect(h.send).not.toHaveBeenCalled();
    expect((await getMoment(h.db, ids[0]!))?.checks).not.toBeNull();
    expect((await getAskMessage(h.db, action.messageId))?.status).toBe("done");
  });
});

describe("POST /api/ask-actions/[id] (tool_approval)", () => {
  /** An answer paused on a card with a clip and a selection change, as the worker's approve node leaves it. */
  async function approvalFor() {
    const { sessionId, moments } = await seedReadySession(h.db, [[10_000, 30_000], [40_000, 60_000], [70_000, 90_000]]);
    const msg = await addAskMessage(h.db, { sessionId, ownerId: OWNER_ID, role: "assistant", text: "", status: "running" });
    const ids = moments.slice(0, 2).map((m) => m.id);
    const action = await createToolApproval(h.db, msg.id, {
      step: 1,
      calls: [
        { id: "c1", name: "propose_clip", args: { start: "00:00:10", end: "00:00:30", title: "Rent caps" }, summary: "Make a clip 00:00:10–00:00:30 'Rent caps'" },
        { id: "c2", name: "set_selection", args: { momentIds: ids, status: "approved" }, summary: "Approve 2 moments", moments: [] },
      ],
    });
    return { sessionId, ids, action, msg };
  }
  const resumeSends = () => h.send.mock.calls.filter((c) => c[0] === QUEUES.askResume);

  it("approve resolves the card once, stores the decision and sends one ask.resume job", async () => {
    const { action, msg } = await approvalFor();
    expect((await getAskMessage(h.db, msg.id))?.status).toBe("waiting");
    const res = await postAction(req({ decision: "approve" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed" });
    expect(await getAskAction(h.db, action.id)).toMatchObject({ status: "confirmed", resolution: { decision: "approve" } });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.askResume, { actionId: action.id }, { ...JOB_OPTIONS, singletonKey: action.id });
    // the worker continues the answer: the route never touches its status
    expect((await getAskMessage(h.db, msg.id))?.status).toBe("waiting");
  });

  it("a double click or two tabs (approve and reject at once) resolve once: one job, the other gets 409", async () => {
    for (const [a, b] of [["approve", "approve"], ["approve", "reject"]] as const) {
      h.send.mockClear();
      const { action } = await approvalFor();
      const [r1, r2] = await Promise.all([postAction(req({ decision: a }), ctx(action.id)), postAction(req({ decision: b }), ctx(action.id))]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(await loser.json()).toEqual({ error: "This suggestion was already handled." });
      expect(resumeSends()).toHaveLength(1);
      const again = await postAction(req({ decision: "reject" }), ctx(action.id));
      expect(again.status).toBe(409);
      expect(resumeSends()).toHaveLength(1);
    }
  });

  async function staleCard() {
    const { sessionId } = await seedReadySession(h.db);
    const clip1 = await createClip(h.db, { sessionId, ownerId: OWNER_ID, startMs: 10_000, endMs: 30_000, actor: "user" });
    const clip2 = await createClip(h.db, { sessionId, ownerId: OWNER_ID, startMs: 40_000, endMs: 60_000, actor: "user" });
    const msg = await addAskMessage(h.db, { sessionId, ownerId: OWNER_ID, role: "assistant", text: "", status: "running" });
    const action = await createToolApproval(h.db, msg.id, {
      step: 1,
      calls: [{
        id: "c1", name: "trim_clip", args: {}, summary: "Change clip 2 00:00:40–00:01:00 to 00:00:41–00:00:59",
        clips: [{ id: clip2.id, n: 2, version: clip2.editVersion }],
      }],
    });
    return { clip1, clip2, action };
  }

  it("Approve on a stale card answers 409 with the stale sentence, stores the stale resolution and resumes", async () => {
    const { clip2, action } = await staleCard();
    await updateClip(h.db, clip2.id, { startMs: 41_000, endMs: 59_000 }, "user");
    const res = await postAction(req({ decision: "approve" }), ctx(action.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Clip 2 changed since this card was made. Ask again.");
    expect(await getAskAction(h.db, action.id)).toMatchObject({ status: "dismissed", resolution: { decision: "reject", stale: [{ n: 2, removed: false }] } });
    expect(h.send).toHaveBeenCalledWith(QUEUES.askResume, { actionId: action.id }, expect.objectContaining({ singletonKey: action.id }));
  });

  it("Approve on an unchanged clip's card goes through", async () => {
    const { action } = await staleCard();
    expect((await postAction(req({ decision: "approve" }), ctx(action.id))).status).toBe(200);
  });

  it("Reject on a stale card is an ordinary reject (200)", async () => {
    const { clip2, action } = await staleCard();
    await updateClip(h.db, clip2.id, { startMs: 41_000, endMs: 59_000 }, "user");
    const res = await postAction(req({ decision: "reject" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(await getAskAction(h.db, action.id)).toMatchObject({ status: "dismissed", resolution: { decision: "reject" } });
  });

  it("reject dismisses the card and still continues the answer", async () => {
    const { action } = await approvalFor();
    const res = await postAction(req({ decision: "reject" }), ctx(action.id));
    expect(await res.json()).toEqual({ status: "dismissed" });
    expect(await getAskAction(h.db, action.id)).toMatchObject({ status: "dismissed", resolution: { decision: "reject" } });
    expect(resumeSends()).toEqual([[QUEUES.askResume, { actionId: action.id }, { ...JOB_OPTIONS, singletonKey: action.id }]]);
  });

  it("edit stores the edited arguments of the card's calls", async () => {
    const { action, ids } = await approvalFor();
    const edits = [
      { id: "c1", args: { start: "00:00:12", end: "00:00:41", title: "  Rents, edited " } },
      { id: "c2", args: { momentIds: [ids[1]] } },
    ];
    const res = await postAction(req({ decision: "edit", edits }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed" });
    expect((await getAskAction(h.db, action.id))?.resolution).toEqual({
      decision: "edit",
      edits: [{ id: "c1", args: { start: "00:00:12", end: "00:00:41", title: "Rents, edited" } }, { id: "c2", args: { momentIds: [ids[1]] } }],
    });
    expect(resumeSends()).toHaveLength(1);
  });

  it("edit with invalid arguments answers 400 and leaves the card pending", async () => {
    const { action, ids } = await approvalFor();
    const other = "00000000-0000-4000-8000-000000000000";
    const bad = [
      [{ id: "c1", args: { start: "abc", end: "00:00:30", title: "x" } }],
      [{ id: "c1", args: { start: "00:00:30", end: "00:00:20", title: "x" } }],
      [{ id: "c1", args: { start: "00:00:10", end: "00:00:30", title: "   " } }],
      [{ id: "c1", args: { start: "00:00:10", end: "00:00:30", title: "x", clipId: other } }],
      [{ id: "c2", args: { momentIds: [other] } }],
      [{ id: "c2", args: { momentIds: [] } }],
      [{ id: "c2", args: { momentIds: [ids[0]], status: "skipped" } }],
      [{ id: "nope", args: {} }],
      [],
    ];
    for (const edits of bad) {
      const res = await postAction(req({ decision: "edit", edits }), ctx(action.id));
      expect(res.status, JSON.stringify(edits)).toBe(400);
    }
    expect((await postAction(req({ decision: "edit" }), ctx(action.id))).status).toBe(400);
    expect((await postAction(req({ decision: "approve", edits: [] }), ctx(action.id))).status).toBe(400);
    expect((await postAction(req({ decision: "confirm" }), ctx(action.id))).status).toBe(400); // that's for bulk_selection
    expect((await getAskAction(h.db, action.id))?.status).toBe("pending");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a bulk_selection card refuses the approval decisions", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
    const msg = await addAskMessage(h.db, { sessionId, ownerId: OWNER_ID, role: "assistant", text: "x", status: "done" });
    const bulk = await createAskAction(h.db, { messageId: msg.id, kind: "bulk_selection", payload: { momentIds: [moments[0]!.id], status: "approved" } });
    expect((await postAction(req({ decision: "approve" }), ctx(bulk.id))).status).toBe(400);
  });

  it("approve once the video was removed answers the friendly VIDEO_REMOVED line, not a 500; reject still ends the answer", async () => {
    const { sessionId, action } = await approvalFor();
    await updateSession(h.db, sessionId, { videoDeletedAt: new Date() });
    for (const body of [{ decision: "approve" }, { decision: "edit", edits: [{ id: "c1", args: { start: "00:00:12", end: "00:00:41", title: "x" } }] }]) {
      const res = await postAction(req(body), ctx(action.id));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: VIDEO_REMOVED });
    }
    expect((await getAskAction(h.db, action.id))?.status).toBe("pending");
    expect(h.send).not.toHaveBeenCalled();
    expect((await postAction(req({ decision: "reject" }), ctx(action.id))).status).toBe(200);
    expect(resumeSends()).toHaveLength(1);
  });

  it("a card whose answer no longer waits answers 409; a failed enqueue reopens the card with 503", async () => {
    const first = await approvalFor();
    await updateSession(h.db, first.sessionId, { stage: "ready" });
    const { finishAskMessage } = await import("@digestor/core/server");
    await finishAskMessage(h.db, first.msg.id, { text: "gone", status: "failed" });
    expect((await postAction(req({ decision: "approve" }), ctx(first.action.id))).status).toBe(409);

    const { action } = await approvalFor();
    h.send.mockRejectedValueOnce(new Error("boom"));
    const res = await postAction(req({ decision: "approve" }), ctx(action.id));
    expect(res.status).toBe(503);
    expect(await getAskAction(h.db, action.id)).toMatchObject({ status: "pending", resolution: null });
    expect((await postAction(req({ decision: "approve" }), ctx(action.id))).status).toBe(200);
  });
});

describe("briefing translations", () => {
  it("translation POST enqueues; GET 404 until saved", async () => {
    const { analysisId } = await seedReadySession(h.db);
    const get = (language: string) => getTranslationRoute(new Request(`http://localhost/x?language=${language}`), ctx(analysisId));
    expect((await get("pt")).status).toBe(404);

    const res = await postTranslation(req({ language: "pt" }), ctx(analysisId));
    expect(res.status).toBe(202);
    expect(h.send).toHaveBeenCalledWith(QUEUES.translateBriefing, { analysisId, language: "pt" }, JOB_OPTIONS);
    expect(await (await get("pt")).json()).toEqual({ status: "pending" });

    await saveTranslation(h.db, analysisId, "pt", "briefing", { lead: [] });
    expect(await (await get("pt")).json()).toEqual({ status: "ready", content: { lead: [] } });
    h.send.mockClear();
    const again = await postTranslation(req({ language: "pt" }), ctx(analysisId));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "ready", content: { lead: [] } });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a second POST while one is pending sends no second job and keeps the row, even when it would fail to send", async () => {
    const { analysisId } = await seedReadySession(h.db);
    expect((await postTranslation(req({ language: "pt" }), ctx(analysisId))).status).toBe(202);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.send.mockClear();
    h.send.mockRejectedValueOnce(new Error("boom"));
    const again = await postTranslation(req({ language: "pt" }), ctx(analysisId));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: "pending" });
    expect(h.send).not.toHaveBeenCalled();
    expect(await getTranslation(h.db, analysisId, "pt", "briefing")).toEqual({ status: "pending", content: null, error: null });
  });

  it("a failed translation reports its error and a new POST resets it to pending", async () => {
    const { analysisId } = await seedReadySession(h.db);
    const { failTranslation, requestTranslation } = await import("@digestor/core/server");
    await requestTranslation(h.db, analysisId, "fr", "briefing");
    await failTranslation(h.db, analysisId, "fr", "briefing", "Couldn't translate the briefing. Please try again.");
    const body = await (await getTranslationRoute(new Request("http://localhost/x?language=fr"), ctx(analysisId))).json();
    expect(body).toEqual({ status: "failed", error: "Couldn't translate the briefing. Please try again." });
    expect((await postTranslation(req({ language: "fr" }), ctx(analysisId))).status).toBe(202);
    expect(await getTranslation(h.db, analysisId, "fr", "briefing")).toEqual({ status: "pending", content: null, error: null });
  });

  it("refuses unknown languages, unknown or running analyses, and rolls back on enqueue failure", async () => {
    const { analysisId, sessionId } = await seedReadySession(h.db);
    expect((await postTranslation(req({ language: "xx" }), ctx(analysisId))).status).toBe(400);
    expect((await postTranslation(req({}), ctx(analysisId))).status).toBe(400);
    expect((await getTranslationRoute(new Request("http://localhost/x?language=xx"), ctx(analysisId))).status).toBe(400);
    expect((await postTranslation(req({ language: "pt" }), ctx("nope"))).status).toBe(404);
    expect((await postTranslation(req({ language: "pt" }), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);

    h.send.mockRejectedValueOnce(new Error("boom"));
    expect((await postTranslation(req({ language: "de" }), ctx(analysisId))).status).toBe(503);
    expect(await getTranslation(h.db, analysisId, "de", "briefing")).toBeNull();

    const running = await startAnalysisVersion(h.db, sessionId, { profile: "interview", reason: "x", models: {}, promptVersions: {} });
    expect((await postTranslation(req({ language: "pt" }), ctx(running.id))).status).toBe(409);
  });
});

describe("POST /api/sessions/[id]/reanalyze", () => {
  it("reanalyze refuses while a version is running", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const ok = await reanalyze(req({ profile: "parliament" }), ctx(sessionId));
    expect(ok.status).toBe(202);
    const running = (await getRunningAnalysis(h.db, sessionId))!;
    expect(running).toMatchObject({ version: 2, profile: "parliament", reason: "Re-analysed as Parliament" });
    expect(h.send).toHaveBeenCalledWith(
      QUEUES.reanalyze,
      { sessionId, profile: "parliament", reason: "Re-analysed as Parliament", analysisId: running.id },
      JOB_OPTIONS,
    );
    h.send.mockClear();
    const res = await reanalyze(req({ profile: "parliament" }), ctx(sessionId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A re-analysis is already running for this video." });
    expect(h.send).not.toHaveBeenCalled();
    await completeAnalysisVersion(h.db, running.id);
    expect((await reanalyze(req({ profile: "un", reason: "Wrong kind" }), ctx(sessionId))).status).toBe(202);
    expect(h.send).toHaveBeenCalledWith(QUEUES.reanalyze, expect.objectContaining({ sessionId, profile: "un", reason: "Wrong kind" }), JOB_OPTIONS);
  });

  it("two parallel POSTs give one 202, one 409, one new version and one job", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const [a, b] = await Promise.all([reanalyze(req({ profile: "other" }), ctx(sessionId)), reanalyze(req({ profile: "other" }), ctx(sessionId))]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((await listAnalysisVersions(h.db, sessionId)).map((v) => v.version)).toEqual([1, 2]);
  });

  it("validates the profile and readiness; a failed enqueue fails the claimed version and answers 503", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect((await reanalyze(req({ profile: "nope" }), ctx(sessionId))).status).toBe(400);
    expect((await reanalyze(req({}), ctx(sessionId))).status).toBe(400);
    expect((await reanalyze(req({ profile: "other" }), ctx("nope"))).status).toBe(404);
    h.send.mockRejectedValueOnce(new Error("boom"));
    expect((await reanalyze(req({ profile: "other" }), ctx(sessionId))).status).toBe(503);
    expect(await getRunningAnalysis(h.db, sessionId)).toBeNull();
    expect((await listAnalysisVersions(h.db, sessionId)).map((v) => v.status)).toEqual(["complete", "failed"]);
    // the user can try again
    expect((await reanalyze(req({ profile: "other" }), ctx(sessionId))).status).toBe(202);
    await updateSession(h.db, sessionId, { stage: "failed" });
    expect((await reanalyze(req({ profile: "other" }), ctx(sessionId))).status).toBe(409);
  });
});

describe("problem reports", () => {
  it("report stores the target", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
    const res = await postReport(req({ sessionId, targetKind: "moment", targetId: moments[0]!.id, note: "  Wrong speaker " }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ sessionId, targetKind: "moment", targetId: moments[0]!.id, note: "Wrong speaker", ownerId: OWNER_ID });
    expect((await postReport(req({ sessionId, targetKind: "briefing", targetId: "x" }))).status).toBe(201);
    expect((await listProblemReports(h.db, OWNER_ID)).filter((r) => r.sessionId === sessionId).map((r) => r.targetKind)).toEqual(["briefing", "moment"]);
  });

  it("reports: accepts targetKind attribution", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const res = await postReport(req({ sessionId, targetKind: "attribution", targetId: "11111111-1111-4111-8111-111111111111", note: "Wrong person" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ sessionId, targetKind: "attribution", note: "Wrong person" });
    expect((await postReport(req({ sessionId, targetKind: "attribution" }))).status).toBe(400);
  });

  it("refuses bad bodies and unknown sessions", async () => {
    const { sessionId } = await seedReadySession(h.db);
    for (const body of [
      { sessionId, targetKind: "nope", targetId: "x" }, { sessionId, targetKind: "moment" }, { sessionId: "nope", targetKind: "moment", targetId: "x" },
      { sessionId, targetKind: "moment", targetId: "x", note: "n".repeat(1001) },
    ]) expect((await postReport(req(body))).status).toBe(400);
    const gone = await postReport(req({ sessionId: "00000000-0000-4000-8000-000000000000", targetKind: "moment", targetId: "x" }));
    expect(gone.status).toBe(404);
    const s = await createSession(h.db, { title: "x", source: "upload" });
    expect((await postReport(req({ sessionId: s.id, targetKind: "clip", targetId: "x" }))).status).toBe(201);
  });
});
