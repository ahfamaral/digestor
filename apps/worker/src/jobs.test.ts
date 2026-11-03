import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { personAt } from "@digestor/core";
import { Command } from "@langchain/langgraph";
import {
  LocalStorage, getPersons, getSessionRecord, linkRecord, listAttributions,
  claimFindMore, completeAnalysisVersion, createCustomPerson, createDb, createSession, getFindMore, listPersonalMoments, requestFindMore,
  saveContextCard, saveMoments, saveTopics, saveTranscript, setHumanAttribution, getSession, getTranslation, requestTranslation, saveBriefing, saveTranslation,
  setStage, startAnalysisVersion, type Db,
} from "@digestor/core/server";
import { FIXTURE_DATE, fakeSenadoFetch, transcriptOfSpeeches } from "./records/fakeSenado.js";
import { FakeLLM } from "./llm/structured.js";
import { TranscriptionError } from "./transcribe/assemblyai.js";
import { MissingApiKeyError, failureMessage, handleResume, handleFindMore, handleNames, FIND_MORE_FAILED, handleTranslateBriefing, TRANSLATE_FAILED, notImplemented, processJobs, handleStart, type JobContext } from "./jobs.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function stubGraph(opts: { next?: string[]; fail?: Error; interrupted?: boolean; checkpoint?: boolean } = {}) {
  const invoke = vi.fn(async (..._a: unknown[]) => {
    if (opts.fail) throw opts.fail;
    return {};
  });
  const getState = vi.fn(async (..._a: unknown[]) => ({
    next: opts.next ?? [],
    tasks: opts.interrupted ? [{ interrupts: [{ value: 1 }] }] : [{ interrupts: [] }],
    // LangGraph only sets createdAt when the thread has a checkpoint.
    ...(opts.checkpoint ? { createdAt: "2026-10-30T12:00:00.000Z" } : {}),
  }));
  return { invoke, getState };
}

/** Attempt metadata as pg-boss passes it (includeMetadata): retryCount 0 is the first try. */
const FIRST = { retryCount: 0, retryLimit: 2 };
const LAST = { retryCount: 2, retryLimit: 2 };

describe("payloads", () => {
  it("invalid payload is logged and completed, valid ones are handled with their attempt", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    const schema = { safeParse: (d: unknown) => (d === "ok" ? { success: true as const, data: d } : { success: false as const, error: { message: "bad" } }) };
    await processJobs("q", schema, handle, [{ data: "nope", ...FIRST }, { data: "ok", retryCount: 1, retryLimit: 2 }]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith("ok", { retryCount: 1, retryLimit: 2 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("failureMessage", () => {
  it("maps known errors", () => {
    expect(failureMessage(new MissingApiKeyError("ANTHROPIC_API_KEY"))).toBe("ANTHROPIC_API_KEY is not set on the server.");
  });
  it("shows a fixed sentence for a transcription error and logs the vendor's text (M1)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(failureMessage(new TranscriptionError("Upstream 0x7f: model shard failed"))).toBe("Transcription failed. Please try again.");
    expect(spy.mock.calls.flat().map(String).join(" ")).toContain("Upstream 0x7f: model shard failed");
    spy.mockRestore();
  });
  it("hides unknown errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(failureMessage(new Error("ECONNRESET secret"))).toBe(
      "Something went wrong while processing this video. Please try again.",
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

d("job handlers", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(() => {
    ({ db, close } = createDb(url!));
  });
  afterAll(() => close());
  const ctxFor = (graph: ReturnType<typeof stubGraph>): JobContext => ({ db, graph: graph as unknown as JobContext["graph"], deps: {} as JobContext["deps"] });
  const newSession = async () => (await createSession(db, { source: "upload", title: "t" })).id;

  it("handleStart starts a fresh run with thread_id = sessionId", async () => {
    const g = stubGraph();
    const id = await newSession();
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    const cfg = { configurable: { thread_id: id } };
    expect(g.invoke).toHaveBeenCalledWith({ sessionId: id }, cfg);
  });

  it("handleStart resumes from an existing checkpoint", async () => {
    const g = stubGraph({ next: ["transcribe"] });
    const id = await newSession();
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    expect(g.invoke).toHaveBeenCalledWith(null, { configurable: { thread_id: id } });
  });

  it("handleStart on a finished thread (checkpoint, nothing pending) is a logged no-op", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const g = stubGraph({ checkpoint: true });
    const id = await newSession();
    await setStage(db, id, "failed", 20, "No speech was detected in this video.");
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    expect(g.invoke).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already finished"));
    log.mockRestore();
  });

  it("handleStart on a ready session is a no-op even without a checkpoint", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const g = stubGraph();
    const id = await newSession();
    await setStage(db, id, "ready", 100);
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    expect(g.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("handleResume passes a Command with the payload", async () => {
    const g = stubGraph({ next: ["context"], interrupted: true });
    const id = await newSession();
    const payload = { action: "continue", answers: [] } as never;
    await handleResume(ctxFor(g), { sessionId: id, payload }, FIRST);
    const [arg, cfg] = g.invoke.mock.calls[0]!;
    expect(arg).toBeInstanceOf(Command);
    expect((arg as Command).resume).toEqual(payload);
    expect(cfg).toEqual({ configurable: { thread_id: id } });
  });

  it("handleResume continues a mid-run thread with null (stale resume is not replayed)", async () => {
    const g = stubGraph({ next: ["finish"] });
    const id = await newSession();
    await handleResume(ctxFor(g), { sessionId: id, payload: { action: "continue", answers: [] } as never }, FIRST);
    expect(g.invoke).toHaveBeenCalledWith(null, { configurable: { thread_id: id } });
  });

  it("handleResume on a finished thread does not invoke", async () => {
    const g = stubGraph();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleResume(ctxFor(g), { sessionId: await newSession(), payload: { action: "continue", answers: [] } as never }, FIRST);
    expect(g.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("a non-final attempt rethrows and leaves the stage untouched (pg-boss retries)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = stubGraph({ fail: new Error("ECONNRESET") });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id }, FIRST)).rejects.toThrow("ECONNRESET");
    await expect(handleStart(ctxFor(g), { sessionId: id }, { retryCount: 1, retryLimit: 2 })).rejects.toThrow("ECONNRESET");
    expect(await getSession(db, id)).toMatchObject({ stage: "transcribing", progress: 40, error: null });
    log.mockRestore();
  });

  it("the final attempt sets stage failed with the friendly message and rethrows", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = stubGraph({ fail: new Error("ECONNRESET secret") });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id }, LAST)).rejects.toThrow("ECONNRESET");
    expect(await getSession(db, id)).toMatchObject({
      stage: "failed",
      progress: 40,
      error: "Something went wrong while processing this video. Please try again.",
    });
    log.mockRestore();
  });

  it.each([
    ["TranscriptionError", new TranscriptionError("boom"), "Transcription failed. Please try again."],
    ["MissingApiKeyError", new MissingApiKeyError("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY is not set on the server."],
  ])("a deterministic %s fails the session at once and completes the job (no retry)", async (_name, err, message) => {
    const g = stubGraph({ fail: err });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, id)).toMatchObject({ stage: "failed", progress: 40, error: message });
  });

  it("handleResume follows the same attempt rules", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = { action: "skip" } as const;
    const id = await newSession();
    await setStage(db, id, "indexing", 70);
    const flaky = stubGraph({ next: ["finish"], fail: new Error("overloaded") });
    await expect(handleResume(ctxFor(flaky), { sessionId: id, payload }, FIRST)).rejects.toThrow("overloaded");
    expect((await getSession(db, id))!.stage).toBe("indexing");
    await expect(handleResume(ctxFor(flaky), { sessionId: id, payload }, LAST)).rejects.toThrow("overloaded");
    expect((await getSession(db, id))!.stage).toBe("failed");

    const keyless = stubGraph({ next: ["finish"], fail: new MissingApiKeyError("ANTHROPIC_API_KEY") });
    const id2 = await newSession();
    await expect(handleResume(ctxFor(keyless), { sessionId: id2, payload }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, id2)).toMatchObject({ stage: "failed", error: "ANTHROPIC_API_KEY is not set on the server." });
    log.mockRestore();
  });
});

d("handleTranslateBriefing", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(() => {
    ({ db, close } = createDb(url!));
  });
  afterAll(() => close());

  async function analysis() {
    const s = await createSession(db, { source: "upload", title: "t" });
    const v = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "t", models: {}, promptVersions: {} });
    await saveBriefing(db, v.id, { lead: [{ text: "Hello.", momentIds: [] }], sections: [] });
    await completeAnalysisVersion(db, v.id);
    return v.id;
  }
  const echo = (c: { user: string }) => ({ lines: [...c.user.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: `PT:${m[2]}` })) });

  it("saves a ready translation", async () => {
    const analysisId = await analysis();
    await requestTranslation(db, analysisId, "pt", "briefing");
    await handleTranslateBriefing({ db, llm: new FakeLLM([echo]) }, { analysisId, language: "pt" }, FIRST);
    expect(await getTranslation(db, analysisId, "pt", "briefing")).toEqual({
      status: "ready", error: null, content: { lead: [{ text: "PT:Hello.", momentIds: [] }], sections: [] },
    });
  });

  it("a missing key fails at once with its message and is not retried", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const analysisId = await analysis();
    await requestTranslation(db, analysisId, "pt", "briefing");
    const llm = new FakeLLM([() => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); }]);
    await expect(handleTranslateBriefing({ db, llm }, { analysisId, language: "pt" }, FIRST)).resolves.toBeUndefined();
    expect(await getTranslation(db, analysisId, "pt", "briefing")).toEqual({ status: "failed", content: null, error: "ANTHROPIC_API_KEY is not set on the server." });
    log.mockRestore();
  });

  it("other errors are retried and only the final attempt marks the row failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const analysisId = await analysis();
    await requestTranslation(db, analysisId, "pt", "briefing");
    const boom = () => new FakeLLM([() => { throw new Error("overloaded"); }]);
    await expect(handleTranslateBriefing({ db, llm: boom() }, { analysisId, language: "pt" }, FIRST)).rejects.toThrow("overloaded");
    expect((await getTranslation(db, analysisId, "pt", "briefing"))?.status).toBe("pending");
    await expect(handleTranslateBriefing({ db, llm: boom() }, { analysisId, language: "pt" }, LAST)).rejects.toThrow("overloaded");
    expect(await getTranslation(db, analysisId, "pt", "briefing")).toEqual({ status: "failed", content: null, error: TRANSLATE_FAILED });
    expect(TRANSLATE_FAILED).toBe("Couldn't translate the briefing. Please try again.");
    log.mockRestore();
  });

  it("does nothing without a pending row (never requested, or already ready)", async () => {
    const analysisId = await analysis();
    const llm = new FakeLLM([]);
    await handleTranslateBriefing({ db, llm }, { analysisId, language: "pt" }, FIRST);
    expect(await getTranslation(db, analysisId, "pt", "briefing")).toBeNull();
    await saveTranslation(db, analysisId, "pt", "briefing", { done: true });
    await handleTranslateBriefing({ db, llm }, { analysisId, language: "pt" }, FIRST);
    expect(llm.calls).toHaveLength(0);
  });
});

d("handleFindMore", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(() => {
    ({ db, close } = createDb(url!));
  });
  afterAll(() => close());

  const none = { value: null, source: null, evidence: null };
  async function request() {
    const s = await createSession(db, { source: "upload", title: "t" });
    const v = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "t", models: {}, promptVersions: {} });
    const words = Array.from({ length: 600 }, (_, i) => ({ text: `w${i}.`, startMs: i * 1000, endMs: i * 1000 + 500, speaker: "A", confidence: 0.9 }));
    await saveTranscript(db, s.id, { words, durationMs: 600_000, language: "en", languageConfidence: 0.9 });
    await saveContextCard(db, s.id, {
      language: none, profile: { value: "interview", confidence: 1, evidence: "x" }, title: none, summary: "s", setting: none, dateOrYear: none,
      participants: [], sufficient: true, openQuestions: [],
    }, 1);
    await saveTopics(db, v.id, [{ idx: 0, startMs: 0, endMs: 600_000, title: "T", summary: "" }]);
    await completeAnalysisVersion(db, v.id);
    const person = await createCustomPerson(db, { displayName: "Tralli", createdBy: "t" });
    await setHumanAttribution(db, { sessionId: s.id, speakerId: "A", startMs: null, endMs: null, personId: person.id, ownerId: "owner" });
    const row = (await requestFindMore(db, { ownerId: "owner", analysisId: v.id, personId: person.id }))!;
    return { row, analysisId: v.id, personId: person.id };
  }
  const state = (r: { analysisId: string; personId: string }) => getFindMore(db, { ownerId: "owner", analysisId: r.analysisId, personId: r.personId });
  const good = { moments: [{ title: "M", why: "w", highlightTypes: [], relevance: 60, granularity: "passage", start: "00:01:00", end: "00:01:40", evidence: [] }] };

  it("stores the moments and marks the request done", async () => {
    const r = await request();
    const llm = new FakeLLM([good]);
    await handleFindMore({ db, llm }, { requestId: r.row.id }, FIRST);
    expect(llm.calls[0]!.user).toContain("Focus person: Tralli");
    expect(await state(r)).toMatchObject({ status: "done", momentCount: 1 });
    expect((await listPersonalMoments(db, "owner", r.analysisId)).map((m) => m.origin)).toEqual(["find_more"]);
  });

  it("a draft duplicating an official moment is dropped and momentCount excludes it", async () => {
    const r = await request();
    await saveMoments(db, r.analysisId, [{
      topicId: null, granularity: "passage", startMs: 60_000, endMs: 100_000, title: "Official", why: "", relevance: 80, speakers: ["A"],
      evidence: [], origin: "ai", highlights: [],
    }]);
    const dup = { ...good.moments[0]!, title: "Dup" };
    const fresh = { ...good.moments[0]!, title: "Fresh", start: "00:03:00", end: "00:03:40" };
    await handleFindMore({ db, llm: new FakeLLM([{ moments: [dup, fresh] }]) }, { requestId: r.row.id }, FIRST);
    expect(await state(r)).toMatchObject({ status: "done", momentCount: 1 });
    expect((await listPersonalMoments(db, "owner", r.analysisId)).map((m) => m.title)).toEqual(["Fresh"]);
  });

  it("a missing key fails the row with its message and doesn't rethrow", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await request();
    const llm = new FakeLLM([() => { throw new MissingApiKeyError("OPENROUTER_API_KEY"); }]);
    await expect(handleFindMore({ db, llm }, { requestId: r.row.id }, FIRST)).resolves.toBeUndefined();
    expect(await state(r)).toMatchObject({ status: "failed", error: "OPENROUTER_API_KEY is not set on the server." });
    log.mockRestore();
  });

  it("a transient error rethrows; a retry continues; only the final attempt fails the row", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await request();
    const boom = () => new FakeLLM([() => { throw new Error("overloaded"); }]);
    await expect(handleFindMore({ db, llm: boom() }, { requestId: r.row.id }, FIRST)).rejects.toThrow("overloaded");
    expect((await state(r))?.status).toBe("running");
    await expect(handleFindMore({ db, llm: boom() }, { requestId: r.row.id }, { retryCount: 1, retryLimit: 2 })).rejects.toThrow("overloaded");
    expect((await state(r))?.status).toBe("running");
    await expect(handleFindMore({ db, llm: boom() }, { requestId: r.row.id }, LAST)).rejects.toThrow("overloaded");
    expect(await state(r)).toMatchObject({ status: "failed", error: FIND_MORE_FAILED });
    log.mockRestore();
  });

  it("a retry after a crash (row running) continues, and a duplicate first delivery does nothing", async () => {
    const r = await request();
    await claimFindMore(db, r.row.id);
    const idle = new FakeLLM([]);
    await handleFindMore({ db, llm: idle }, { requestId: r.row.id }, FIRST); // someone else has it
    expect(idle.calls).toHaveLength(0);
    await handleFindMore({ db, llm: new FakeLLM([good]) }, { requestId: r.row.id }, { retryCount: 1, retryLimit: 2 });
    expect((await state(r))?.status).toBe("done");
  });
});

describe("queues without a consumer yet", () => {
  it("complete their jobs with a log line instead of retrying", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(notImplemented("track.burn")({ trackId: "x" }, FIRST)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("track.burn: not implemented yet"));
    log.mockRestore();
  });
});

d("handleNames", () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    root = await mkdtemp(path.join(os.tmpdir(), "digestor-names-"));
  });
  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  async function setup(o: { fake?: Parameters<typeof fakeSenadoFetch>[0]; link?: boolean } = {}) {
    const s = await createSession(db, { source: "upload", title: "Senado" });
    await saveTranscript(db, s.id, transcriptOfSpeeches());
    if (o.link !== false) await linkRecord(db, s.id, { chamber: "senado", date: FIXTURE_DATE, sessionCode: null, url: "https://example/record" });
    const { f, calls } = fakeSenadoFetch(o.fake);
    const deps = { db, storage: new LocalStorage(root), fetch: f } as unknown as JobContext["deps"];
    return { id: s.id, ctx: { db, deps }, calls };
  }
  const recordRows = async (id: string) => (await listAttributions(db, id)).filter((a) => a.source === "record");

  it("handleNames matches the record and writes confirmed ranged rows with official persons", async () => {
    const { id, ctx, calls } = await setup();
    await handleNames(ctx, { sessionId: id }, FIRST);
    const rows = await recordRows(id);
    expect(rows.map((r) => r.speakerId).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(rows.every((r) => r.status === "confirmed" && r.startMs !== null && r.endMs !== null)).toBe(true);
    expect(rows[0]!.evidence).toMatchObject({ kind: "record", url: "https://example/record" });
    const e = rows.find((r) => r.speakerId === "E")!; // speech 524142 by senator 5906
    expect(e.evidence).toMatchObject({ speechId: "524142" });
    const person = (await getPersons(db, [e.personId!]))[0]!;
    expect(person).toMatchObject({ kind: "official", displayName: "Dra. Eudócia", party: "PSDB", state: "AL", officialIds: { senado: "5906" } });
    expect(person.photoUrl).toBe("https://www.senado.leg.br/senadores/img/fotos-oficiais/senador5906.jpg");
    expect(calls.filter((c) => c.includes("/senador/")).length).toBe(5); // once per senator
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "matched", error: null, rawKey: `${id}/names/record.json` });
    expect((await readFile(path.join(root, id, "names/record.json"), "utf8")).length).toBeGreaterThan(1000);
    // Running again (a re-link) supersedes only its own rows: one current row per voice.
    await linkRecord(db, id, (await getSessionRecord(db, id))!.ref);
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await recordRows(id)).toHaveLength(5);
  });

  it("handleNames never supersedes human rows", async () => {
    const { id, ctx } = await setup();
    const mine = await createCustomPerson(db, { displayName: "Minha Escolha", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId: id, speakerId: "A", startMs: null, endMs: null, personId: mine.id, ownerId: "owner" });
    await handleNames(ctx, { sessionId: id }, FIRST);
    const humans = (await listAttributions(db, id)).filter((a) => a.source === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({ speakerId: "A", personId: mine.id, supersededAt: null });
    expect(personAt(await listAttributions(db, id), "A", 1000)).toMatchObject({ kind: "named", personId: mine.id });
  });

  it("handleNames: no speeches → failed with the friendly line, no rethrow", async () => {
    const { id, ctx } = await setup({ fake: { list: () => new Response(JSON.stringify({ DiscursosSessao: { Sessoes: null } }), { status: 200 }) } });
    await expect(handleNames(ctx, { sessionId: id }, FIRST)).resolves.toBeUndefined();
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "The Senado has no speeches for that date." });
    expect(await recordRows(id)).toEqual([]);
  });

  it("handleNames: a 5xx rethrows until the final attempt, then failed with the friendly line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { id, ctx } = await setup({ fake: { list: () => new Response("boom", { status: 503 }) } });
    await expect(handleNames(ctx, { sessionId: id }, FIRST)).rejects.toThrow();
    expect((await getSessionRecord(db, id))?.status).toBe("running"); // still waiting for the retry
    await expect(handleNames(ctx, { sessionId: id }, { retryCount: 1, retryLimit: 2 })).rejects.toThrow();
    expect((await getSessionRecord(db, id))?.status).toBe("running");
    await expect(handleNames(ctx, { sessionId: id }, LAST)).rejects.toThrow();
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "The Senado record couldn't be fetched. Please try again." });
    log.mockRestore();
  });

  it("a retry after a transient error takes over its own running row and matches", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let down = true;
    const { id, ctx } = await setup({ fake: { list: () => (down ? new Response("boom", { status: 503 }) : new Response(JSON.stringify(JSON.parse(readFileSync(new URL("../test/fixtures/senado-discursos-2026-09-02.json", import.meta.url), "utf8"))), { status: 200 })) } });
    await expect(handleNames(ctx, { sessionId: id }, FIRST)).rejects.toThrow();
    down = false;
    await handleNames(ctx, { sessionId: id }, { retryCount: 1, retryLimit: 2 });
    expect((await getSessionRecord(db, id))?.status).toBe("matched");
    log.mockRestore();
  });

  it("a Câmara record fails with the unsupported line, and a session with no record is left alone", async () => {
    const { id, ctx } = await setup({ link: false });
    await handleNames(ctx, { sessionId: id }, FIRST); // nothing linked: nothing happens
    expect(await getSessionRecord(db, id)).toBeNull();
    await linkRecord(db, id, { chamber: "camara", eventId: "76000", url: "https://www.camara.leg.br/evento-legislativo/76000" });
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "Câmara records aren't supported yet." });
  });

  it("summary-only speeches give proposals only", async () => {
    const { id, ctx } = await setup({ fake: { text: () => new Response("", { status: 404 }) } });
    await handleNames(ctx, { sessionId: id }, FIRST);
    const rows = await recordRows(id);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "matched" });
  });
});
