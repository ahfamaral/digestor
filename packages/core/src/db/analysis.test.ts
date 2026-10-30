import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import {
  completeAnalysisVersion, failAnalysisVersion, getCurrentAnalysis, getMoment, getRunningAnalysis, getTranslation,
  saveBriefing, saveMoments, saveTopics, saveTranslation, setMomentChecks, setMomentThumb, startAnalysisVersion,
  type NewMoment,
} from "./analysis.ts";
import { createSession, deleteSession, getSession, setStage, transitionStage, updateSession, type Session } from "./repo.ts";
import { analysisVersions } from "./schema.ts";
import { eq } from "drizzle-orm";

const META = { profile: "interview", reason: "first analysis", models: { reasoning: "m" }, promptVersions: { topics: "topics@1" } };

const moment = (over: Partial<NewMoment> = {}): NewMoment => ({
  topicId: null, granularity: "passage", startMs: 1000, endMs: 40_000, title: "T", why: "Why: w", relevance: 80,
  speakers: ["A"], evidence: ["quote"], origin: "ai", highlights: [{ type: "heated", method: "ai", value: null }], ...over,
});

let db: Db;
let close: () => Promise<void>;
let s: Session;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await pool.end();
  s = await createSession(db, { title: "T", source: "upload" });
});

describe("analysis versions", () => {
  it("startAnalysisVersion numbers versions and reuses a running one", async () => {
    const v1 = await startAnalysisVersion(db, s.id, META);
    expect(v1.version).toBe(1);
    await completeAnalysisVersion(db, v1.id);
    const v2 = await startAnalysisVersion(db, s.id, META);
    expect(v2.version).toBe(2);
    await saveTopics(db, v2.id, [{ idx: 0, startMs: 0, endMs: 60_000, title: "A", summary: "s" }]);
    expect(await startAnalysisVersion(db, s.id, META)).toEqual(v2);
    const running = await getRunningAnalysis(db, s.id);
    expect(running?.id).toBe(v2.id);
    await completeAnalysisVersion(db, v2.id);
    expect((await getCurrentAnalysis(db, s.id))!.topics).toEqual([]);
  });

  it("completeAnalysisVersion moves isCurrent", async () => {
    const v1 = await startAnalysisVersion(db, s.id, META);
    await completeAnalysisVersion(db, v1.id);
    const v2 = await startAnalysisVersion(db, s.id, { ...META, reason: "re-run" });
    expect(await getCurrentAnalysis(db, s.id)).toMatchObject({ version: { version: 1, reason: "first analysis", status: "complete" } });
    await completeAnalysisVersion(db, v2.id);
    expect(await getCurrentAnalysis(db, s.id)).toMatchObject({ version: { version: 2, reason: "re-run", status: "complete" } });
    const [row] = await db.select().from(analysisVersions).where(eq(analysisVersions.id, v1.id));
    expect(row!.isCurrent).toBe(false);
  });

  it("failAnalysisVersion marks failed, so the next start numbers a new version", async () => {
    const v1 = await startAnalysisVersion(db, s.id, META);
    await failAnalysisVersion(db, v1.id);
    expect(await getRunningAnalysis(db, s.id)).toBeNull();
    expect(await getCurrentAnalysis(db, s.id)).toBeNull();
    expect((await startAnalysisVersion(db, s.id, META)).version).toBe(2);
  });

  it("saveMoments resolves insideIdx and stores highlights", async () => {
    const v = await startAnalysisVersion(db, s.id, META);
    const [t] = await saveTopics(db, v.id, [{ idx: 0, startMs: 0, endMs: 60_000, title: "A", summary: "s" }]);
    const saved = await saveMoments(db, v.id, [
      moment({ granularity: "exchange", topicId: t!.id }),
      moment({ granularity: "punchline", startMs: 2000, endMs: 10_000, insideIdx: 0, topicId: t!.id }),
    ]);
    expect(saved).toHaveLength(2);
    await saveBriefing(db, v.id, { lead: [{ text: "x", momentIds: [saved[0]!.id] }], sections: [] });
    await completeAnalysisVersion(db, v.id);
    const bundle = (await getCurrentAnalysis(db, s.id))!;
    expect(bundle.moments).toHaveLength(2);
    expect(bundle.moments[1]!.insideMomentId).toBe(bundle.moments[0]!.id);
    expect(bundle.moments[0]!.insideMomentId).toBeNull();
    expect(bundle.moments[1]!.highlights).toEqual([{ type: "heated", method: "ai", value: null }]);
    expect(bundle.topics.map((x) => x.title)).toEqual(["A"]);
    expect(bundle.briefing?.lead[0]!.text).toBe("x");
  });

  it("getCurrentAnalysis ignores personal moments", async () => {
    const v = await startAnalysisVersion(db, s.id, META);
    await saveMoments(db, v.id, [moment({ title: "official" }), moment({ title: "mine", ownerId: "owner", origin: "user" })]);
    await completeAnalysisVersion(db, v.id);
    expect((await getCurrentAnalysis(db, s.id))!.moments.map((m) => m.title)).toEqual(["official"]);
  });

  it("sets checks and thumbnail, and gets one moment", async () => {
    const v = await startAnalysisVersion(db, s.id, META);
    const [m] = await saveMoments(db, v.id, [moment()]);
    const checks = {
      argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
    };
    await setMomentChecks(db, m!.id, checks);
    await setMomentThumb(db, m!.id, `${s.id}/thumbs/${m!.id}.jpg`);
    expect(await getMoment(db, m!.id)).toMatchObject({ checks, thumbKey: `${s.id}/thumbs/${m!.id}.jpg` });
    expect(await getMoment(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("round-trips translations and cascades on session delete", async () => {
    const v = await startAnalysisVersion(db, s.id, META);
    expect(await getTranslation(db, v.id, "pt", "briefing")).toBeNull();
    await saveTranslation(db, v.id, "pt", "briefing", { a: 1 });
    await saveTranslation(db, v.id, "pt", "briefing", { a: 2 });
    expect(await getTranslation(db, v.id, "pt", "briefing")).toEqual({ a: 2 });
    await deleteSession(db, s.id);
    expect(await getRunningAnalysis(db, s.id)).toBeNull();
  });
});

describe("session v2 columns", () => {
  it("has defaults for owner, video flags and updatedAt", async () => {
    expect(s).toMatchObject({ ownerId: "owner", hasVideo: true, audioOnlyAck: false, videoDeletedAt: null, profile: null });
  });

  it("setStage, transitionStage and updateSession bump updatedAt", async () => {
    let prev = s.updatedAt.getTime();
    const bumped = async () => {
      const now = (await getSession(db, s.id))!.updatedAt.getTime();
      expect(now).toBeGreaterThan(prev);
      prev = now;
    };
    await new Promise((r) => setTimeout(r, 15));
    await setStage(db, s.id, "preparing", 5);
    await bumped();
    await new Promise((r) => setTimeout(r, 15));
    await transitionStage(db, s.id, "preparing", "transcribing", 20);
    await bumped();
    await new Promise((r) => setTimeout(r, 15));
    await updateSession(db, s.id, { profile: "trial" });
    await bumped();
  });
});
