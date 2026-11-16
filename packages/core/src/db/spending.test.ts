import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { completeAnalysisVersion, startAnalysisVersion } from "./analysis.ts";
import { createSession, saveTranscript, updateSession } from "./repo.ts";
import { listSpendingRows } from "./spending.ts";

const META = { profile: "interview", reason: "first analysis", models: { reasoning: "m" }, promptVersions: { topics: "topics@1" } };
const USAGE = { "anthropic/claude-haiku-5.5": { calls: 4, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, costUsd: 0.03, unpricedCalls: 0 } };

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await pool.end();
});

describe("listSpendingRows", () => {
  it("gives each session its length, transcript and analysis usages", async () => {
    const a = await createSession(db, { title: "A", source: "upload" });
    await updateSession(db, a.id, { durationMs: 3_600_000 });
    await saveTranscript(db, a.id, { language: "en", languageConfidence: 1, durationMs: 3_500_000, words: [] });
    const v1 = await startAnalysisVersion(db, a.id, META);
    await completeAnalysisVersion(db, v1.id, { usage: USAGE });
    await startAnalysisVersion(db, a.id, META);
    const b = await createSession(db, { title: "B", source: "youtube" });

    const rows = await listSpendingRows(db);
    const ra = rows.find((r) => r.sessionId === a.id)!;
    expect(ra).toMatchObject({ durationMs: 3_600_000, hasVideo: true, transcribed: true });
    expect(ra.analyses.map((x) => x.usage)).toEqual([USAGE, {}]);
    expect(rows.find((r) => r.sessionId === b.id)).toMatchObject({ durationMs: null, transcribed: false, analyses: [] });
  });
});
