import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { personAt, type ResumePayload, type Word } from "@digestor/core";
import { stripRecordMarkup } from "./records/align.js";
import { runPipeline } from "./pipeline/run.js";
import {
  LocalStorage, sessionRecords, claimRecordFetch, replaceAiAttributions, getPersons, getSessionRecord, linkRecord, listAttributions,
  claimFindMore, completeAnalysisVersion, createCustomPerson, createDb, createSession, getFindMore, listPersonalMoments, requestFindMore,
  saveContextCard, saveMoments, saveTopics, saveTranscript, setHumanAttribution, getSession, getTranslation, requestTranslation, saveBriefing, saveTranslation,
  setStage, startAnalysisVersion, claimProxy, finishProxy, requestProxy, updateSession, type Db,
} from "@digestor/core/server";
import { FIXTURE_EVENT_ID, fakeCamaraFetch, fixtureDiscursos as camaraDiscursos, transcriptOfDeputies } from "./records/fakeCamara.js";
import { FIXTURE_DATE, fakeSenadoFetch, fixtureDiscursos, fixtureTexts, transcriptOfSpeeches } from "./records/fakeSenado.js";
import { FakeLLM } from "./llm/structured.js";
import { TranscriptionError } from "./transcribe/assemblyai.js";
import { MissingApiKeyError, failureMessage, handleResume, handleFindMore, handleNames, FIND_MORE_FAILED, handleTranslateBriefing, TRANSLATE_FAILED, processJobs, handleStart, handleProxy, type JobContext } from "./jobs.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

// Only handleStart/handleResume reach the runner; the runner itself is tested on a real database in run.test.ts.
vi.mock("./pipeline/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pipeline/run.js")>()),
  runPipeline: vi.fn(async () => "done" as const),
}));
const runner = vi.mocked(runPipeline);
const failRunner = (err: Error) => runner.mockImplementation(async () => Promise.reject(err));

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
  let ctx: JobContext;
  const deps = {} as JobContext["deps"];
  beforeAll(() => {
    ({ db, close } = createDb(url!));
    ctx = { db, deps };
  });
  afterAll(() => close());
  const newSession = async () => (await createSession(db, { source: "upload", title: "t" })).id;
  beforeEach(() => {
    runner.mockReset();
    runner.mockImplementation(async () => "done");
  });

  it("handleStart runs the pipeline for the session", async () => {
    const id = await newSession();
    await handleStart(ctx, { sessionId: id }, FIRST);
    expect(runner).toHaveBeenCalledExactlyOnceWith(deps, id);
  });

  it("handleResume runs the pipeline with the answer", async () => {
    const id = await newSession();
    const payload: ResumePayload = { action: "continue", answers: [], cardEdits: {} };
    await handleResume(ctx, { sessionId: id, payload }, FIRST);
    expect(runner).toHaveBeenCalledExactlyOnceWith(deps, id, { resume: payload });
  });

  it("handleResume passes the job's round to runPipeline", async () => {
    const id = await newSession();
    const payload: ResumePayload = { action: "skip" };
    await handleResume(ctx, { sessionId: id, payload, round: 2 }, FIRST);
    expect(runner).toHaveBeenCalledExactlyOnceWith(deps, id, { resume: payload, round: 2 });
  });

  it("a non-final attempt rethrows and leaves the stage untouched (pg-boss retries)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    failRunner(new Error("ECONNRESET"));
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctx, { sessionId: id }, FIRST)).rejects.toThrow("ECONNRESET");
    await expect(handleStart(ctx, { sessionId: id }, { retryCount: 1, retryLimit: 2 })).rejects.toThrow("ECONNRESET");
    expect(await getSession(db, id)).toMatchObject({ stage: "transcribing", progress: 40, error: null });
    log.mockRestore();
  });

  it("the final attempt sets stage failed with the friendly message and rethrows", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    failRunner(new Error("ECONNRESET secret"));
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctx, { sessionId: id }, LAST)).rejects.toThrow("ECONNRESET");
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
    failRunner(err);
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctx, { sessionId: id }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, id)).toMatchObject({ stage: "failed", progress: 40, error: message });
  });

  describe("the upload goal", () => {
    const withGoal = async () => {
      const id = await newSession();
      await updateSession(db, id, { goal: "The heated exchanges" });
      return id;
    };
    const goalCtx = (enqueueAsk: (id: string) => Promise<void>): JobContext => ({ db, deps: { db, enqueueAsk } as unknown as JobContext["deps"] });

    it("handleStart starts Ask on the goal once the run made the session ready", async () => {
      const id = await withGoal();
      runner.mockImplementation(async () => { await setStage(db, id, "ready", 100); return "done"; });
      const enqueueAsk = vi.fn(async (_id: string) => {});
      await handleStart(goalCtx(enqueueAsk), { sessionId: id }, FIRST);
      expect(enqueueAsk).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["handleStart", (c: JobContext, id: string, a: { retryCount: number; retryLimit: number }) => handleStart(c, { sessionId: id }, a)],
      ["handleResume", (c: JobContext, id: string, a: { retryCount: number; retryLimit: number }) => handleResume(c, { sessionId: id, payload: { action: "skip" } }, a)],
    ])("%s that throws after the session became ready still starts the goal, once", async (_name, run) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const id = await withGoal();
      runner.mockImplementation(async () => { await setStage(db, id, "ready", 100); throw new Error("ECONNRESET"); });
      const enqueueAsk = vi.fn(async (_id: string) => {});
      await expect(run(goalCtx(enqueueAsk), id, FIRST)).rejects.toThrow("ECONNRESET");
      await expect(run(goalCtx(enqueueAsk), id, { retryCount: 1, retryLimit: 2 })).rejects.toThrow("ECONNRESET");
      expect(enqueueAsk).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });
  });

  it("handleResume follows the same attempt rules", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = { action: "skip" } as const;
    const id = await newSession();
    await setStage(db, id, "indexing", 70);
    failRunner(new Error("overloaded"));
    await expect(handleResume(ctx, { sessionId: id, payload }, FIRST)).rejects.toThrow("overloaded");
    expect((await getSession(db, id))!.stage).toBe("indexing");
    await expect(handleResume(ctx, { sessionId: id, payload }, LAST)).rejects.toThrow("overloaded");
    expect((await getSession(db, id))!.stage).toBe("failed");

    failRunner(new MissingApiKeyError("ANTHROPIC_API_KEY"));
    const id2 = await newSession();
    await expect(handleResume(ctx, { sessionId: id2, payload }, FIRST)).resolves.toBeUndefined();
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

  it("a transient failure on the final attempt inside the publish window keeps waiting (6 h), outside it fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const today = new Date().toISOString().slice(0, 10);
    const { id, ctx } = await setup({ link: false, fake: { list: () => new Response("boom", { status: 503 }) } });
    const ref = { chamber: "senado" as const, date: today, sessionCode: null, url: "https://example/record" };
    await linkRecord(db, id, ref);
    await expect(handleNames(ctx, { sessionId: id }, LAST)).resolves.toBeUndefined();
    const row = (await getSessionRecord(db, id))!;
    expect(row.status).toBe("waiting");
    expect(row.error).toBe("The Senado record couldn't be fetched just now. Digestor will try again.");
    expect(row.retryAt!.getTime() - Date.now()).toBeGreaterThan(5.9 * 3_600_000);
    expect(row.retryAt!.getTime() - Date.now()).toBeLessThan(6.1 * 3_600_000);
    expect(log.mock.calls.some((c) => String(c[0]).includes("inside its publish window"))).toBe(true);
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

  it("a session with no linked record is left alone", async () => {
    const { id, ctx } = await setup({ link: false });
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await getSessionRecord(db, id)).toBeNull();
  });

  describe("a Câmara record", () => {
    const camaraRef = { chamber: "camara" as const, eventId: FIXTURE_EVENT_ID, url: `https://www.camara.leg.br/evento-legislativo/${FIXTURE_EVENT_ID}` };
    async function camaraSetup(o: Parameters<typeof fakeCamaraFetch>[0] = {}) {
      const s = await createSession(db, { source: "upload", title: "Câmara" });
      await saveTranscript(db, s.id, transcriptOfDeputies());
      await linkRecord(db, s.id, camaraRef);
      const { f, calls } = fakeCamaraFetch(o);
      const deps = { db, storage: new LocalStorage(root), fetch: f } as unknown as JobContext["deps"];
      return { id: s.id, ctx: { db, deps }, calls };
    }

    it("handleNames uses the Câmara client for a Câmara ref", async () => {
      const { id, ctx, calls } = await camaraSetup();
      await handleNames(ctx, { sessionId: id }, FIRST);
      expect(calls.some((c) => c.includes("dadosabertos.camara.leg.br"))).toBe(true);
      const rows = await recordRows(id);
      expect(rows.map((r) => r.speakerId).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
      expect(rows.every((r) => r.status === "confirmed" && r.startMs !== null)).toBe(true);
      expect(rows[0]!.evidence).toMatchObject({ kind: "record", url: camaraRef.url });
      // voice A is Glauber Braga, the first of SPEAKER_IDS
      const a = rows.find((r) => r.speakerId === "A")!;
      const person = (await getPersons(db, [a.personId!]))[0]!;
      expect(person).toMatchObject({ kind: "official", displayName: "Glauber Braga", officialIds: { camara: "152605" }, party: expect.any(String), state: expect.any(String) });
      expect(person.photoUrl).toMatch(/^https:\/\//);
      expect(await getSessionRecord(db, id)).toMatchObject({ status: "matched", error: null, rawKey: `${id}/names/record.json` });
      expect(JSON.parse(await readFile(path.join(root, id, "names/record.json"), "utf8")).speeches.length).toBeGreaterThan(20);
    });

    it("two speeches sharing a block stamp, in the reverse of the transcript order, are both named", async () => {
      const first = camaraDiscursos["204441"]!.dados[0]!; // Otoni de Paula speaks first in this video...
      const second = camaraDiscursos["152605"]!.dados[0]!; // ...then Glauber Braga, whose deputy id sorts lower
      const stamped = (d: { dados: object[] }) => ({ ...d, dados: [{ ...d.dados[0]!, dataHoraInicio: "2026-06-30T17:52" }] });
      const words: Word[] = [];
      let t = 0;
      [[first, "A"], [second, "B"]].forEach(([sp, voice]) => {
        for (const text of stripRecordMarkup((sp as typeof first).transcricao).split(/\s+/).filter(Boolean)) {
          words.push({ text, startMs: t, endMs: t + 300, speaker: voice as string, confidence: 0.99 });
          t += 400;
        }
        t += 1000;
      });
      const { id, ctx } = await camaraSetup({
        discursos: (dep) => new Response(JSON.stringify(dep === "204441" ? stamped({ dados: [first] }) : dep === "152605" ? stamped({ dados: [second] }) : { dados: [], links: [] }), { status: 200 }),
      });
      await saveTranscript(db, id, { language: "pt", languageConfidence: 1, durationMs: t, words });
      await handleNames(ctx, { sessionId: id }, FIRST);
      const rows = await recordRows(id);
      expect(rows.map((r) => r.speakerId).sort()).toEqual(["A", "B"]);
      const names = await Promise.all(["A", "B"].map(async (v) => (await getPersons(db, [rows.find((r) => r.speakerId === v)!.personId!]))[0]!.displayName));
      expect(names).toEqual(["Otoni de Paula", "Glauber Braga"]);
    });

    it("an unknown event: failed with the Câmara line, no rethrow", async () => {
      const { id, ctx } = await camaraSetup();
      await linkRecord(db, id, { ...camaraRef, eventId: "1", url: "https://www.camara.leg.br/evento-legislativo/1" });
      await expect(handleNames(ctx, { sessionId: id }, FIRST)).resolves.toBeUndefined();
      expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "The Câmara has no speeches for that session." });
    });

    it("no speech matches the video: failed with the event's date in the line", async () => {
      const { id, ctx } = await camaraSetup();
      const words = Array.from({ length: 30 }, (_, i) => ({ text: `zzqx${i}`, startMs: i * 400, endMs: i * 400 + 300, speaker: "A", confidence: 1 }));
      await saveTranscript(db, id, { language: "pt", languageConfidence: 1, durationMs: 12_000, words });
      await handleNames(ctx, { sessionId: id }, FIRST);
      expect(await recordRows(id)).toEqual([]);
      expect(await getSessionRecord(db, id)).toMatchObject({
        status: "failed", error: "None of the speeches in the Câmara record of 30/06/2026 match this video. Check the link.",
      });
    });

    it("a deputy call that keeps failing: rethrown; on the final attempt a freshly linked event (inside its window since linkedAt) keeps waiting", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { id, ctx } = await camaraSetup({ discursos: () => new Response("boom", { status: 503 }) });
      await expect(handleNames(ctx, { sessionId: id }, FIRST)).rejects.toThrow();
      expect((await getSessionRecord(db, id))?.status).toBe("running");
      await expect(handleNames(ctx, { sessionId: id }, LAST)).resolves.toBeUndefined();
      expect(await getSessionRecord(db, id)).toMatchObject({ status: "waiting", error: "The Câmara record couldn't be fetched just now. Digestor will try again." });
      log.mockRestore();
    });

    it("a deputy call that keeps failing, linked longer ago than the window: the final attempt fails the row", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { id, ctx } = await camaraSetup({ discursos: () => new Response("boom", { status: 503 }) });
      await expect(handleNames(ctx, { sessionId: id }, FIRST)).rejects.toThrow();
      await db.update(sessionRecords).set({ linkedAt: new Date(Date.now() - 4 * 86_400_000) }).where(eq(sessionRecords.sessionId, id));
      await expect(handleNames(ctx, { sessionId: id }, LAST)).rejects.toThrow();
      expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "The Câmara record couldn't be fetched. Please try again." });
      log.mockRestore();
    });
  });

  it("fetches a senator once even when they gave two speeches", async () => {
    const day = structuredClone(fixtureDiscursos) as { DiscursosSessao: { Sessoes: { Sessao: { Pronunciamentos: { Pronunciamento: Record<string, unknown>[] } }[] } } };
    for (const sess of day.DiscursosSessao.Sessoes.Sessao) {
      for (const p of sess.Pronunciamentos.Pronunciamento) if (p.CodigoPronunciamento === "524182") p.CodigoParlamentar = "6335"; // Damares speaks twice
    }
    const { id, ctx, calls } = await setup({ fake: { list: () => new Response(JSON.stringify(day), { status: 200 }) } });
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(calls.filter((c) => c.includes("/senador/6335.json"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/senador/"))).toHaveLength(4);
    expect((await recordRows(id)).length).toBeGreaterThanOrEqual(5);
  });

  it("a re-link to another date during a run: the old run writes nothing and doesn't mark the new row matched", async () => {
    let id = "";
    const other = { chamber: "senado" as const, date: "2026-09-03", sessionCode: null, url: "https://example/other" };
    const s = await setup({ fake: { list: async () => { await linkRecord(db, id, other); return new Response(JSON.stringify(fixtureDiscursos), { status: 200 }); } } });
    id = s.id;
    await handleNames(s.ctx, { sessionId: id }, FIRST);
    expect(await recordRows(id)).toEqual([]);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "pending", ref: other, rawKey: null });
  });

  it("a record that then can't be matched leaves no rows of the earlier record current (rejections stay)", async () => {
    const { id, ctx } = await setup();
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await recordRows(id)).toHaveLength(5);
    const cur = (await recordRows(id))[0]!;
    await replaceAiAttributions(db, id, "record", [
      ...(await recordRows(id)).map((r) => ({ speakerId: r.speakerId, startMs: r.startMs, endMs: r.endMs, personId: r.personId, status: r.id === cur.id ? ("rejected" as const) : r.status, confidence: r.confidence, evidence: r.evidence })),
    ]);
    await linkRecord(db, id, { chamber: "senado", date: "2026-09-04", sessionCode: null, url: "https://example/empty" });
    const empty = fakeSenadoFetch({ list: () => new Response(JSON.stringify({ DiscursosSessao: { Sessoes: null } }), { status: 200 }) });
    await handleNames({ db, deps: { ...ctx.deps, fetch: empty.f } as JobContext["deps"] }, { sessionId: id }, FIRST);
    expect((await recordRows(id)).map((r) => r.status)).toEqual(["rejected"]);
    await linkRecord(db, id, { chamber: "camara", eventId: "1", url: "https://www.camara.leg.br/evento-legislativo/1" });
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect((await recordRows(id)).map((r) => r.status)).toEqual(["rejected"]);
  });

  it("no speech matches the video: failed with the date in the line, no rows, not matched", async () => {
    const { id, ctx } = await setup();
    const words = Array.from({ length: 30 }, (_, i) => ({ text: `zzqx${i}`, startMs: i * 400, endMs: i * 400 + 300, speaker: "A", confidence: 1 }));
    await saveTranscript(db, id, { language: "pt", languageConfidence: 1, durationMs: 12_000, words });
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await recordRows(id)).toEqual([]);
    expect(await getSessionRecord(db, id)).toMatchObject({
      status: "failed", error: "None of the speeches in the Senado record of 02/09/2026 match this video. Check the date.",
    });
  });

  it("every match rejected by a human: failed with its own line", async () => {
    const { id, ctx } = await setup();
    await handleNames(ctx, { sessionId: id }, FIRST);
    const rows = await recordRows(id);
    await replaceAiAttributions(db, id, "record", rows.map((r) => ({ speakerId: r.speakerId, startMs: r.startMs, endMs: r.endMs, personId: r.personId, status: "rejected" as const, confidence: r.confidence, evidence: r.evidence })));
    await linkRecord(db, id, (await getSessionRecord(db, id))!.ref); // the same record again
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "No speech in the record was kept for this video." });
  });

  it("a session code that isn't on that day: the row's error is the session line", async () => {
    const { id, ctx } = await setup();
    await linkRecord(db, id, { chamber: "senado", date: FIXTURE_DATE, sessionCode: "999", url: "https://example/s" });
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "That Senado session wasn't found on 02/09/2026." });
  });

  it("re-link A to B, B failing transiently on its final attempt: A's rows are not current, B is failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { id, ctx } = await setup();
    await handleNames(ctx, { sessionId: id }, FIRST);
    expect(await recordRows(id)).toHaveLength(5);
    await linkRecord(db, id, { chamber: "senado", date: "2026-09-03", sessionCode: null, url: "https://example/b" });
    expect(await recordRows(id)).toEqual([]); // gone at once, before any run
    const down = { db, deps: { ...ctx.deps, fetch: fakeSenadoFetch({ list: () => new Response("boom", { status: 503 }) }).f } as JobContext["deps"] };
    await expect(handleNames(down, { sessionId: id }, LAST)).rejects.toThrow();
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "failed", error: "The Senado record couldn't be fetched. Please try again." });
    expect(await recordRows(id)).toEqual([]);
    log.mockRestore();
  });

  it("an old run's final failure doesn't fail a newer running claim", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let id = "";
    let first = true;
    const b = { chamber: "senado" as const, date: "2026-09-03", sessionCode: null, url: "https://example/b" };
    const s = await setup({
      fake: {
        list: async () => {
          if (first) { first = false; await linkRecord(db, id, b); await claimRecordFetch(db, id); } // B is linked and running now
          return new Response("boom", { status: 503 });
        },
      },
    });
    id = s.id;
    await expect(handleNames(s.ctx, { sessionId: id }, LAST)).rejects.toThrow();
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "running", ref: b, error: null });
    log.mockRestore();
  });

  it("summary-only speeches give proposals only", async () => {
    // The API's Resumo is a short summary: here the first half of each speech; the full texts are missing (404).
    const day = structuredClone(fixtureDiscursos) as { DiscursosSessao: { Sessoes: { Sessao: { Pronunciamentos: { Pronunciamento: Record<string, unknown>[] } }[] } } };
    for (const sess of day.DiscursosSessao.Sessoes.Sessao) {
      for (const p of sess.Pronunciamentos.Pronunciamento) {
        const text = fixtureTexts[p.CodigoPronunciamento as string];
        if (text) p.Resumo = text.slice(0, Math.floor(text.length / 2));
      }
    }
    const { id, ctx } = await setup({ fake: { list: () => new Response(JSON.stringify(day), { status: 200 }), text: () => new Response("", { status: 404 }) } });
    await handleNames(ctx, { sessionId: id }, FIRST);
    const rows = await recordRows(id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "matched" });
  });

});

d("handleProxy (the preview copy job)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  let storage: LocalStorage;
  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    root = await mkdtemp(path.join(os.tmpdir(), "digestor-proxy-"));
    storage = new LocalStorage(root);
  });
  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  const fakeMedia = (fail?: Error) => ({
    makeProxy: vi.fn(async (_in: string, out: string, _o?: { hasVideo?: boolean }) => {
      if (fail) throw fail;
      await writeFile(out, "proxy");
      return undefined;
    }),
  });
  /** A session in preparing_preview whose copy is requested (the state after ingest and a finished analysis). */
  async function seed(opts: { original?: boolean; stage?: "preparing_preview" | "awaiting_context" } = {}) {
    const s = await createSession(db, { title: "P", source: "upload" });
    const originalKey = storage.key(s.id, "original.mp4");
    await mkdir(path.dirname(storage.resolve(originalKey)), { recursive: true });
    if (opts.original !== false) await writeFile(storage.resolve(originalKey), "video");
    await updateSession(db, s.id, { originalKey, hasVideo: true });
    await setStage(db, s.id, opts.stage ?? "preparing_preview", 96);
    await requestProxy(db, s.id);
    return s.id;
  }

  /** `audio.mp3` on disk and in the row, as ingest leaves it. */
  async function withAudio(id: string) {
    await writeFile(storage.resolve(`${id}/audio.mp3`), "audio");
    await updateSession(db, id, { audioKey: `${id}/audio.mp3` });
  }
  const hasAudioFile = (id: string) => readFile(storage.resolve(`${id}/audio.mp3`)).then(() => true, () => false);

  it("the copy that makes a session with a goal ready starts Ask once", async () => {
    const id = await seed();
    await updateSession(db, id, { goal: "The heated exchanges" });
    const enqueueAsk = vi.fn(async (_id: string) => {});
    await handleProxy({ db, storage, media: fakeMedia(), enqueueAsk }, { sessionId: id }, FIRST);
    await handleProxy({ db, storage, media: fakeMedia(), enqueueAsk }, { sessionId: id }, FIRST);
    expect(enqueueAsk).toHaveBeenCalledTimes(1);
  });

  it("a copy job that throws while the session is ready still starts Ask on the goal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await seed();
    await updateSession(db, id, { goal: "The heated exchanges" });
    const enqueueAsk = vi.fn(async (_id: string) => {});
    const media = { makeProxy: vi.fn(async () => { await setStage(db, id, "ready", 100); throw new Error("ffmpeg died"); }) };
    await expect(handleProxy({ db, storage, media, enqueueAsk }, { sessionId: id }, FIRST)).rejects.toThrow("ffmpeg died");
    expect(enqueueAsk).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("handleProxy claims, encodes, finishes and settles; the ready session's audio.mp3 goes", async () => {
    const id = await seed();
    await withAudio(id);
    const media = fakeMedia();
    await handleProxy({ db, storage, media }, { sessionId: id }, FIRST);
    expect(media.makeProxy).toHaveBeenCalledExactlyOnceWith(storage.resolve(`${id}/original.mp4`), storage.resolve(`${id}/proxy.mp4`), { hasVideo: true });
    expect(await getSession(db, id)).toMatchObject({ proxyStatus: "done", proxyKey: `${id}/proxy.mp4`, stage: "ready", progress: 100, audioKey: null });
    expect(await hasAudioFile(id)).toBe(false);
  });

  it("finishing while the analysis is still running leaves the stage for the analysis end (and keeps the audio)", async () => {
    const id = await seed({ stage: "awaiting_context" });
    await withAudio(id);
    await handleProxy({ db, storage, media: fakeMedia() }, { sessionId: id }, FIRST);
    expect(await getSession(db, id)).toMatchObject({ proxyStatus: "done", proxyKey: `${id}/proxy.mp4`, stage: "awaiting_context", audioKey: `${id}/audio.mp3` });
    expect(await hasAudioFile(id)).toBe(true);
  });

  it("a second job finds nothing to claim", async () => {
    const id = await seed();
    await handleProxy({ db, storage, media: fakeMedia() }, { sessionId: id }, FIRST);
    const again = fakeMedia();
    await handleProxy({ db, storage, media: again }, { sessionId: id }, FIRST);
    expect(again.makeProxy).not.toHaveBeenCalled();
    // ... and a first delivery against a row another job is running does nothing either
    const other = await seed();
    await claimProxy(db, other);
    await handleProxy({ db, storage, media: again }, { sessionId: other }, FIRST);
    expect(again.makeProxy).not.toHaveBeenCalled();
  });

  it("a retry after a crash between finishing the copy and the join still closes the join and releases the audio", async () => {
    const id = await seed();
    await withAudio(id);
    await claimProxy(db, id);
    await finishProxy(db, id, `${id}/proxy.mp4`); // ... and the worker died before settlePreview
    expect(await getSession(db, id)).toMatchObject({ proxyStatus: "done", stage: "preparing_preview" });
    const media = fakeMedia();
    await handleProxy({ db, storage, media }, { sessionId: id }, { retryCount: 1, retryLimit: 2 });
    expect(media.makeProxy).not.toHaveBeenCalled();
    expect(await getSession(db, id)).toMatchObject({ proxyStatus: "done", stage: "ready", audioKey: null });
    expect(await hasAudioFile(id)).toBe(false);
  });

  it("a transient ffmpeg error rethrows and keeps the claim; a retry takes it over", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await seed();
    await expect(handleProxy({ db, storage, media: fakeMedia(new Error("ffmpeg died")) }, { sessionId: id }, FIRST)).rejects.toThrow("ffmpeg died");
    expect(await getSession(db, id)).toMatchObject({ proxyStatus: "running", stage: "preparing_preview" });
    await handleProxy({ db, storage, media: fakeMedia() }, { sessionId: id }, { retryCount: 1, retryLimit: 2 });
    expect(await getSession(db, id)).toMatchObject({ proxyStatus: "done", stage: "ready" });
    log.mockRestore();
  });

  it("final-attempt failure marks failed and settles", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await seed();
    await expect(handleProxy({ db, storage, media: fakeMedia(new Error("ffmpeg died")) }, { sessionId: id }, LAST)).rejects.toThrow("ffmpeg died");
    expect(await getSession(db, id)).toMatchObject({
      proxyStatus: "failed", stage: "failed", error: "The video preview couldn't be prepared. Please try again.",
    });
    log.mockRestore();
  });

  it("deleted video → failed, no retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const removed = await seed();
    await updateSession(db, removed, { videoDeletedAt: new Date() });
    const media = fakeMedia();
    await expect(handleProxy({ db, storage, media }, { sessionId: removed }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, removed)).toMatchObject({ proxyStatus: "failed", stage: "failed" });
    const missing = await seed({ original: false });
    await expect(handleProxy({ db, storage, media }, { sessionId: missing }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, missing)).toMatchObject({ proxyStatus: "failed", stage: "failed" });
    expect(media.makeProxy).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
