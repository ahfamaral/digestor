import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextCard, Fact, Transcript, Word } from "@digestor/core";
import {
  LocalStorage,
  claimAnalysisVersion,
  claimProxy,
  failProxy,
  finishProxy,
  requestProxy,
  settlePreview,
  claimMomentCheck,
  createDb,
  failAnalysisVersion,
  createSession,
  getCurrentAnalysis,
  getMoment,
  getRunningAnalysis,
  getSession,
  listAnalysisVersions,
  createCustomPerson,
  saveContextCard,
  saveTranscript,
  setHumanAttribution,
  setStage,
  updateSession,
  type Db,
} from "@digestor/core/server";
import { MissingApiKeyError } from "../errors.js";
import { handleCheckMoment, handleReanalyze, type JobContext } from "../jobs.js";
import { FakeLLM, type FakeCall, type StructuredLLM } from "../llm/structured.js";
import { PROMPT_VERSIONS, runAnalysis, type AnalysisDeps } from "./analysis.js";
import { CHECKS_OK, analysisResponses, crashOnInsert } from "./fakeAnalysis.js";
import type { PipelineDeps } from "./graph.js";

// 200 sentences, one every 3 s ("Sentence number N."), speakers alternating every 10 sentences: 600 s.
function mkWords(sentences: number): Word[] {
  const out: Word[] = [];
  for (let s = 0; s < sentences; s++) {
    const speaker = Math.floor(s / 10) % 2 === 0 ? "A" : "B";
    ["Sentence", "number", `${s}.`].forEach((text, i) =>
      out.push({ text, startMs: s * 3000 + i * 600, endMs: s * 3000 + i * 600 + 500, speaker, confidence: 0.99 }),
    );
  }
  return out;
}
const transcript: Transcript = { language: "en", languageConfidence: 0.97, durationMs: 600_000, words: mkWords(200) };
const TOPICS = [
  { title: "Budget", startMs: 0, endMs: 300_000 },
  { title: "Health", startMs: 300_000, endMs: 600_000 },
];

const none: Fact = { value: null, source: null, evidence: null };
const card: ContextCard = {
  language: { value: "en", source: "video", evidence: "detected" },
  profile: { value: "interview", confidence: 0.9, evidence: "Sentence number 2." },
  title: none,
  summary: "An interview.",
  setting: none,
  dateOrYear: { value: "2026", source: "metadata", evidence: "2026" },
  participants: [],
  sufficient: true,
  openQuestions: [],
};

let db: Db;
let close: () => Promise<void>;
let root: string;
let storage: LocalStorage;

beforeAll(async () => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
  root = await mkdtemp(path.join(os.tmpdir(), "digestor-analysis-"));
  storage = new LocalStorage(root);
});
afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

/** A session at the end of the context step (stage `indexing`), with transcript and card but no video work needed. */
async function seed() {
  const s = await createSession(db, { title: "Seeded", source: "upload" });
  await updateSession(db, s.id, { proxyKey: `${s.id}/proxy.mp4`, durationMs: 600_000, language: "en", profile: "interview" });
  await saveTranscript(db, s.id, transcript);
  await saveContextCard(db, s.id, card, 1);
  await setStage(db, s.id, "indexing", 70);
  return s.id;
}

function mkDeps(llm: StructuredLLM) {
  const thumbs: { input: string; atMs: number; output: string }[] = [];
  const media = {
    thumbnail: async (input: string, atMs: number, output: string) => {
      thumbs.push({ input, atMs, output });
      return { stdout: "", stderr: "" };
    },
  };
  const deps: AnalysisDeps = { db, storage, llm, media };
  return { deps, thumbs };
}

/** Wraps an LLM and records the session's stage at every call. */
function stageRecorder(inner: StructuredLLM, sessionId: () => string) {
  const seen: [string, string, number][] = [];
  const llm: StructuredLLM = {
    async generate(a) {
      const s = (await getSession(db, sessionId()))!;
      seen.push([a.name, s.stage, s.progress]);
      return inner.generate(a);
    },
  };
  return { llm, seen };
}

const versionsOf = (sessionId: string) => listAnalysisVersions(db, sessionId);

describe("runAnalysis", () => {
  it("records the model ids the LLM reports (provider-qualified for OpenRouter)", async () => {
    const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) });
    const llm: StructuredLLM = {
      modelIds: { reasoning: "openrouter:anthropic/claude-sonnet-5.5", fast: "openrouter:anthropic/claude-haiku-5.5" },
      generate: (a) => fake.generate(a),
    };
    const id = await seed();

    await runAnalysis(mkDeps(llm).deps, id, { profile: "interview", reason: "initial" });

    const [v] = await versionsOf(id);
    expect(v!.models).toEqual({
      topics: "openrouter:anthropic/claude-sonnet-5.5",
      moments: "openrouter:anthropic/claude-sonnet-5.5",
      punchlines: "openrouter:anthropic/claude-sonnet-5.5",
      briefing: "openrouter:anthropic/claude-sonnet-5.5",
      checks: "openrouter:anthropic/claude-haiku-5.5",
    });
  });

  it("walks the analysis stages and stores one complete version with its models and prompt versions", async () => {
    const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) });
    let id = "";
    const { llm, seen } = stageRecorder(fake, () => id);
    const { deps, thumbs } = mkDeps(llm);
    id = await seed();

    await runAnalysis(deps, id, { profile: "interview", reason: "initial" });

    // Stage sequence (indexing 70 was set by the index node before this).
    expect(seen.map(([name, stage, progress]) => `${name}@${stage}:${progress}`)).toEqual([
      "topics@finding_topics:75",
      "moments@finding_moments:82",
      "moments@finding_moments:82",
      "punchlines@finding_moments:82",
      "punchlines@finding_moments:82",
      "gap_punchlines@finding_moments:82",
      "gap_punchlines@finding_moments:82",
      "briefing@writing_briefing:92",
      "checks@writing_briefing:92",
      "checks@writing_briefing:92",
      "checks@writing_briefing:92",
    ]);
    expect(await getSession(db, id)).toMatchObject({ stage: "ready", progress: 100, profile: "interview" });

    const [v] = await versionsOf(id);
    expect(v).toMatchObject({
      version: 1,
      status: "complete",
      isCurrent: true,
      reason: "initial",
      profile: "interview",
      pipelineVersion: "2.0.0",
      promptVersions: { topics: "topics@1", moments: "moments@1", punchlines: "punchlines@2", briefing: "briefing@1", checks: "checks@1" },
      models: {
        topics: "claude-sonnet-5-5",
        moments: "claude-sonnet-5-5",
        punchlines: "claude-sonnet-5-5",
        briefing: "claude-sonnet-5-5",
        checks: "claude-haiku-5-5",
      },
    });
    expect(PROMPT_VERSIONS).toEqual(v!.promptVersions);

    const bundle = (await getCurrentAnalysis(db, id))!;
    expect(bundle.topics.map((t) => t.title)).toEqual(["Budget", "Health"]);
    expect(bundle.moments.map((m) => m.granularity).sort()).toEqual(
      ["exchange", "exchange", "passage", "passage", "punchline", "punchline"],
    );
    expect(bundle.briefing!.lead).toHaveLength(1);
    expect(bundle.briefing!.sections).toHaveLength(2);

    // Top highlights (heated, key_point, quotable) are checked and get a thumbnail at their midpoint; the rest don't.
    const checked = bundle.moments.filter((m) => m.checks !== null);
    expect(checked).toHaveLength(3);
    expect(checked.every((m) => m.thumbKey === `${id}/thumbs/${m.id}.jpg`)).toBe(true);
    expect(bundle.moments.filter((m) => m.checks === null).every((m) => m.thumbKey === null)).toBe(true);
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]!.input).toBe(storage.resolve(`${id}/proxy.mp4`));
    const first = checked.find((m) => storage.resolve(m.thumbKey!) === thumbs[0]!.output)!;
    expect(thumbs[0]!.atMs).toBe(Math.round((first.startMs + first.endMs) / 2));
  });

  it("a single failed check or thumbnail is logged and skipped", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const responses = analysisResponses({ topics: TOPICS });
      responses.checks = [() => { throw new Error("overloaded"); }, CHECKS_OK, CHECKS_OK] as never;
      const { deps } = mkDeps(new FakeLLM({ byName: responses }));
      let n = 0;
      deps.media = {
        thumbnail: async () => {
          if (++n === 2) throw new Error("ffmpeg died");
          return { stdout: "", stderr: "" };
        },
      };
      const id = await seed();
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const bundle = (await getCurrentAnalysis(db, id))!;
      expect(bundle.moments.filter((m) => m.checks !== null)).toHaveLength(2);
      expect(bundle.moments.filter((m) => m.thumbKey !== null)).toHaveLength(2);
      expect(await getSession(db, id)).toMatchObject({ stage: "ready" });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("a missing API key in the checks is not skipped: it escapes, and the version stays unfinished", async () => {
    const responses = analysisResponses({ topics: TOPICS });
    responses.checks = [() => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); }] as never;
    const { deps } = mkDeps(new FakeLLM({ byName: responses }));
    const id = await seed();
    await expect(runAnalysis(deps, id, { profile: "interview", reason: "initial" })).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(await getCurrentAnalysis(db, id)).toBeNull();
    expect((await getSession(db, id))!.stage).toBe("writing_briefing");
  });

  it("skips thumbnails for an audio-only session or a removed video", async () => {
    for (const patch of [{ hasVideo: false }, { videoDeletedAt: new Date() }]) {
      const { deps, thumbs } = mkDeps(new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) }));
      const id = await seed();
      await updateSession(db, id, patch);
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      expect(thumbs).toHaveLength(0);
      expect((await getCurrentAnalysis(db, id))!.moments.filter((m) => m.checks !== null)).toHaveLength(3);
    }
  });
});

describe("the join with the preview copy", () => {
  /** A seeded session whose copy is requested but not made yet (the state after ingest). */
  async function seedWithCopyPending() {
    const id = await seed();
    await updateSession(db, id, { proxyKey: null, proxyStatus: null });
    await requestProxy(db, id);
    await claimProxy(db, id);
    return id;
  }
  const analyse = async (id: string) => runAnalysis(mkDeps(new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) })).deps, id, { profile: "interview", reason: "initial" });

  it("analysis done first → preparing_preview, then the copy finishes → ready", async () => {
    const id = await seedWithCopyPending();
    await analyse(id);
    expect(await getSession(db, id)).toMatchObject({ stage: "preparing_preview", progress: 96, profile: "interview" });
    expect(await getCurrentAnalysis(db, id)).not.toBeNull();
    await finishProxy(db, id, `${id}/proxy.mp4`);
    await settlePreview(db, id);
    expect(await getSession(db, id)).toMatchObject({ stage: "ready", progress: 100, error: null });
  });

  it("copy done first → analysis end → ready", async () => {
    const id = await seedWithCopyPending();
    await finishProxy(db, id, `${id}/proxy.mp4`);
    await settlePreview(db, id); // not preparing_preview yet: nothing
    expect((await getSession(db, id))!.stage).toBe("indexing");
    await analyse(id);
    expect(await getSession(db, id)).toMatchObject({ stage: "ready", progress: 100 });
  });

  it("copy failed → the session is failed with the line once the analysis ends", async () => {
    const id = await seedWithCopyPending();
    await failProxy(db, id);
    await analyse(id);
    expect(await getSession(db, id)).toMatchObject({ stage: "failed", error: "The video preview couldn't be prepared. Please try again." });
  });

  it("a re-analysis never touches the stage", async () => {
    const id = await seedWithCopyPending();
    await analyse(id);
    await finishProxy(db, id, `${id}/proxy.mp4`);
    await settlePreview(db, id);
    const deps = mkDeps(new FakeLLM({ byName: analysisResponses({ topics: TOPICS, runs: 1 }) })).deps;
    await runAnalysis(deps, id, { profile: "parliament", reason: "r" });
    expect(await getSession(db, id)).toMatchObject({ stage: "ready", progress: 100, profile: "parliament" });
  });
});

describe("re-analysis and check jobs", () => {
  const ctxFor = (deps: AnalysisDeps): JobContext => ({
    db,
    deps: deps as PipelineDeps,
    graph: {} as JobContext["graph"],
  });

  it("reanalysis keeps the session ready and the old version readable until complete", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const blocked = new Promise<void>((r) => (reached = r));
    const responses = analysisResponses({ topics: TOPICS, runs: 2 });
    // The second run's topics call blocks until the test has looked at the session.
    responses.topics[1] = (async () => {
      reached();
      await gate;
      return { topics: [{ title: "Everything", summary: "All of it.", start: "00:00:00", end: "00:10:00" }] };
    }) as never;
    const fake = new FakeLLM({ byName: responses });
    const { deps } = mkDeps(fake);
    const id = await seed();
    await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
    const v1 = (await getCurrentAnalysis(db, id))!;
    const v1Moments = v1.moments.length;

    const run = handleReanalyze(ctxFor(deps), { sessionId: id, profile: "parliament", reason: "It is a parliament debate" }, { retryCount: 0, retryLimit: 2 });
    await blocked;
    // Mid-run: v2 is running, the session stays ready, and readers still get v1.
    expect(await getSession(db, id)).toMatchObject({ stage: "ready", progress: 100, profile: "interview" });
    expect(await getRunningAnalysis(db, id)).toMatchObject({ version: 2, profile: "parliament", reason: "It is a parliament debate" });
    const during = (await getCurrentAnalysis(db, id))!;
    expect(during.version).toMatchObject({ id: v1.version.id, version: 1 });
    expect(during.moments).toHaveLength(v1Moments);

    release();
    await run;
    const after = (await getCurrentAnalysis(db, id))!;
    expect(after.version).toMatchObject({ version: 2, profile: "parliament", status: "complete" });
    expect(after.topics.map((t) => t.title)).toEqual(["Everything"]);
    // Parliament counts the longest speech.
    expect(after.moments.some((m) => m.highlights.some((h) => h.type === "longest_speech" && h.method === "counted"))).toBe(true);
    expect(await getSession(db, id)).toMatchObject({ stage: "ready", progress: 100, profile: "parliament" });
    const rows = await versionsOf(id);
    expect(rows.map((r) => [r.version, r.status, r.isCurrent]).sort()).toEqual([
      [1, "complete", false],
      [2, "complete", true],
    ]);
    // The moments prompt of the re-analysis uses the new profile's types.
    const lastMoments = fake.calls.filter((c: FakeCall) => c.name === "moments").at(-1)!;
    expect(lastMoments.system).toContain("strong_argument");
  });

  it("a reanalysis job fills the version it carries, and ignores one that is no longer running", async () => {
    const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS, runs: 2 }) });
    const { deps } = mkDeps(fake);
    const id = await seed();
    await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
    const claimed = (await claimAnalysisVersion(db, id, { profile: "parliament", reason: "r" }))!;
    const attempt = { retryCount: 0, retryLimit: 2 };
    await handleReanalyze(ctxFor(deps), { sessionId: id, profile: "parliament", reason: "r", analysisId: claimed.id }, attempt);
    const rows = await versionsOf(id);
    expect(rows.map((r) => [r.id === claimed.id ? "claimed" : "old", r.version, r.status])).toEqual([["old", 1, "complete"], ["claimed", 2, "complete"]]);
    expect((await getCurrentAnalysis(db, id))!.version.id).toBe(claimed.id);

    // a job whose version was failed meanwhile (e.g. swept) does nothing and starts no new version
    const gone = (await claimAnalysisVersion(db, id, { profile: "un", reason: "r" }))!;
    await failAnalysisVersion(db, gone.id);
    const calls = fake.calls.length;
    await handleReanalyze(ctxFor(deps), { sessionId: id, profile: "un", reason: "r", analysisId: gone.id }, attempt);
    expect(fake.calls).toHaveLength(calls);
    expect(await versionsOf(id)).toHaveLength(3);
  });

  it("a reanalysis that gives up fails its version and leaves the session ready on the old one", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const responses = analysisResponses({ topics: TOPICS, runs: 2 });
      const { deps } = mkDeps(new FakeLLM({ byName: responses }));
      const id = await seed();
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      // Transient error on a non-final attempt: rethrown for pg-boss, version left running for the retry.
      const broken = mkDeps({ generate: async () => { throw new Error("socket hang up"); } }).deps;
      // findTopics degrades on a plain error, so break the DB write of the topics instead: a crash mid-analysis.
      const crashing: AnalysisDeps = { ...broken, db: crashOnInsert(db, "topics") };
      const job = { sessionId: id, profile: "trial" as const, reason: "retry me" };
      await expect(handleReanalyze(ctxFor(crashing), job, { retryCount: 0, retryLimit: 2 })).rejects.toThrow("worker crashed");
      expect(await getRunningAnalysis(db, id)).toMatchObject({ version: 2 });
      // Final attempt: the version is failed, the session stays ready on v1 and keeps its profile.
      await expect(handleReanalyze(ctxFor({ ...broken, db: crashOnInsert(db, "topics") }), job, { retryCount: 2, retryLimit: 2 })).rejects.toThrow("worker crashed");
      expect(await getRunningAnalysis(db, id)).toBeNull();
      expect((await versionsOf(id)).map((r) => [r.version, r.status]).sort()).toEqual([[1, "complete"], [2, "failed"]]);
      expect(await getCurrentAnalysis(db, id)).toMatchObject({ version: { version: 1 } });
      expect(await getSession(db, id)).toMatchObject({ stage: "ready", profile: "interview", error: null });

      // A missing key gives up at once (no retry) and fails the version the same way.
      const keyless = mkDeps({ generate: async () => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); } }).deps;
      await expect(handleReanalyze(ctxFor(keyless), { ...job, reason: "again" }, { retryCount: 0, retryLimit: 2 })).resolves.toBeUndefined();
      expect((await versionsOf(id)).map((r) => [r.version, r.status]).sort()).toEqual([[1, "complete"], [2, "failed"], [3, "failed"]]);
      expect(await getSession(db, id)).toMatchObject({ stage: "ready" });
    } finally {
      log.mockRestore();
    }
  });

  it("reanalysis of a session that isn't ready is ignored", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) });
      const { deps } = mkDeps(fake);
      const id = await seed(); // stage indexing: the first analysis hasn't run yet
      await handleReanalyze(ctxFor(deps), { sessionId: id, profile: "trial", reason: "x" }, { retryCount: 0, retryLimit: 2 });
      expect(fake.calls).toHaveLength(0);
      expect(await versionsOf(id)).toHaveLength(0);
      expect(await getSession(db, id)).toMatchObject({ stage: "indexing", profile: "interview" });
    } finally {
      out.mockRestore();
    }
  });

  it("a reanalysis whose session is no longer ready fails the version it carries (T17)", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) });
      const { deps } = mkDeps(fake);
      const id = await seed();
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const claimed = (await claimAnalysisVersion(db, id, { profile: "trial", reason: "x" }))!;
      const other = await seed();
      await runAnalysis(deps, other, { profile: "interview", reason: "initial" });
      const othersClaim = (await claimAnalysisVersion(db, other, { profile: "trial", reason: "x" }))!;
      await updateSession(db, id, { stage: "failed" });
      const calls = fake.calls.length;
      await handleReanalyze(ctxFor(deps), { sessionId: id, profile: "trial", reason: "x", analysisId: claimed.id }, { retryCount: 0, retryLimit: 2 });
      expect(fake.calls).toHaveLength(calls);
      expect((await versionsOf(id)).find((v) => v.id === claimed.id)?.status).toBe("failed");
      // a carried id from another session is never touched
      await handleReanalyze(ctxFor(deps), { sessionId: id, profile: "trial", reason: "x", analysisId: othersClaim.id }, { retryCount: 0, retryLimit: 2 });
      expect((await getRunningAnalysis(db, other))?.id).toBe(othersClaim.id);
    } finally {
      out.mockRestore();
    }
  });

  it("check job is idempotent", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const responses = analysisResponses({ topics: TOPICS });
      responses.checks = [...responses.checks.slice(0, 3), { ...CHECKS_OK, argumentComplete: false, contextRisk: " Sarcasm. " }];
      const fake = new FakeLLM({ byName: responses });
      const { deps } = mkDeps(fake);
      const id = await seed();
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const unchecked = (await getCurrentAnalysis(db, id))!.moments.find((m) => m.checks === null)!;

      const before = fake.calls.length;
      await handleCheckMoment(ctxFor(deps), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 });
      expect(fake.calls.length).toBe(before + 1);
      expect(fake.calls.at(-1)!.name).toBe("checks");
      const checks = (await getMoment(db, unchecked.id))!.checks!;
      expect(checks).toMatchObject({ argumentComplete: false, contextRisk: "Sarcasm." });
      expect(checks.continuesWith).toMatch(/^Sentence number \d+\.$/);

      await handleCheckMoment(ctxFor(deps), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 });
      expect(fake.calls.length).toBe(before + 1); // no second LLM call
      expect((await getMoment(db, unchecked.id))!.checks).toEqual(checks);

      // An unknown moment is logged and completed.
      await handleCheckMoment(ctxFor(deps), { momentId: "00000000-0000-4000-8000-000000000000" }, { retryCount: 0, retryLimit: 2 });
      expect(fake.calls.length).toBe(before + 1);
    } finally {
      out.mockRestore();
    }
  });

  it("check job: a missing key completes the job without checks; other errors are retried", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = mkDeps(new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) }));
      const id = await seed();
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const unchecked = (await getCurrentAnalysis(db, id))!.moments.find((m) => m.checks === null)!;
      const keyless = mkDeps({ generate: async () => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); } }).deps;
      await expect(handleCheckMoment(ctxFor(keyless), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 })).resolves.toBeUndefined();
      const flaky = mkDeps({ generate: async () => { throw new Error("overloaded"); } }).deps;
      await expect(handleCheckMoment(ctxFor(flaky), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow("overloaded");
      expect((await getMoment(db, unchecked.id))!.checks).toBeNull();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("check job: giving up on the final attempt frees the claim so Check again can send (R29)", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = mkDeps(new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) }));
      const id = await seed();
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const unchecked = (await getCurrentAnalysis(db, id))!.moments.find((m) => m.checks === null)!;
      expect(await claimMomentCheck(db, unchecked.id)).toBe(true);
      const flaky = mkDeps({ generate: async () => { throw new Error("overloaded"); } }).deps;
      await expect(handleCheckMoment(ctxFor(flaky), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow();
      expect(await claimMomentCheck(db, unchecked.id)).toBe(false); // a retry is coming: still claimed
      await expect(handleCheckMoment(ctxFor(flaky), { momentId: unchecked.id }, { retryCount: 2, retryLimit: 2 })).rejects.toThrow();
      expect(await claimMomentCheck(db, unchecked.id)).toBe(true); // gave up: free again
      // a missing key keeps the claim (nothing could succeed yet; the 10-minute window throttles new sends)
      const keyless = mkDeps({ generate: async () => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); } }).deps;
      await handleCheckMoment(ctxFor(keyless), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 });
      expect(await claimMomentCheck(db, unchecked.id)).toBe(false);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
  describe("names in the prompts come from the current attributions (spec §6.1)", () => {
    const named = (a: string, b: string): ContextCard => ({
      ...card,
      participants: [
        { speakerId: "A", name: { value: a, source: "video", evidence: a }, role: none, affiliation: none },
        { speakerId: "B", name: { value: b, source: "human", evidence: b }, role: none, affiliation: none },
      ],
    });
    const prompts = (fake: FakeLLM) => fake.calls.map((c) => `${c.system}\n${c.user}`);

    it("a re-analysis after a rename writes with the new name", async () => {
      const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS, runs: 2 }) });
      const { deps } = mkDeps(fake);
      const id = await seed();
      await saveContextCard(db, id, named("Velho Nome", "Outro Velho"), 1);
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const before = fake.calls.length;
      const p = await createCustomPerson(db, { displayName: "Nome Novo", createdBy: "owner" });
      await setHumanAttribution(db, { sessionId: id, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });

      await handleReanalyze(ctxFor(deps), { sessionId: id, profile: "interview", reason: "names" }, { retryCount: 0, retryLimit: 2 });
      const after = prompts(fake).slice(before);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((t) => t.includes("Nome Novo"))).toBe(true);
      expect(after.some((t) => t.includes("Velho Nome") || t.includes("Outro Velho"))).toBe(false);
    });

    it("a voice marked No name in a trial is never named in any prompt, nor is a proposal", async () => {
      const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) });
      const { deps } = mkDeps(fake);
      const id = await seed();
      await saveContextCard(db, id, named("Pessoa Protegida", "Testemunha Humana"), 1);
      await setHumanAttribution(db, { sessionId: id, speakerId: "A", startMs: null, endMs: null, personId: null, ownerId: "owner" });
      await runAnalysis(deps, id, { profile: "trial", reason: "initial" });
      const unchecked = (await getCurrentAnalysis(db, id))!.moments.find((m) => m.checks === null)!;
      await handleCheckMoment(ctxFor(deps), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 });
      expect(fake.calls.at(-1)!.name).toBe("checks");
      expect(prompts(fake).some((t) => t.includes("Pessoa Protegida") || t.includes("Testemunha Humana"))).toBe(false);
    });

    it("the on-demand check job uses the current names", async () => {
      const fake = new FakeLLM({ byName: analysisResponses({ topics: TOPICS }) });
      const { deps } = mkDeps(fake);
      const id = await seed();
      await saveContextCard(db, id, named("Velho Nome", "Outro Velho"), 1);
      await runAnalysis(deps, id, { profile: "interview", reason: "initial" });
      const p = await createCustomPerson(db, { displayName: "Checada Nova", createdBy: "owner" });
      await setHumanAttribution(db, { sessionId: id, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
      const unchecked = (await getCurrentAnalysis(db, id))!.moments.find((m) => m.checks === null)!;
      await handleCheckMoment(ctxFor(deps), { momentId: unchecked.id }, { retryCount: 0, retryLimit: 2 });
      const last = prompts(fake).at(-1)!;
      expect(last).toContain("Checada Nova");
      expect(last).not.toContain("Velho Nome");
    });
  });
});
