import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { createSession, getSession, setStage, type Session } from "./repo.ts";
import { pipelineRuns } from "./schema.ts";
import { advancePipelineRun, deletePipelineRun, ensurePipelineRun, getPipelineRun } from "./pipeline.ts";

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

describe("pipeline runs", () => {
  it("ensurePipelineRun creates once and returns the existing row the second time", async () => {
    expect(await getPipelineRun(db, s.id)).toBeNull();
    const a = await ensurePipelineRun(db, s.id, "download");
    expect(a).toMatchObject({ sessionId: s.id, nextStep: "download", round: 0, answers: [] });
    await advancePipelineRun(db, s.id, "download", "ingest");
    const b = await ensurePipelineRun(db, s.id, "download");
    expect(b.nextStep).toBe("ingest");
  });

  it("advancePipelineRun moves only from the expected step", async () => {
    await ensurePipelineRun(db, s.id, "download");
    await setStage(db, s.id, "uploaded", 0);
    const ok = await advancePipelineRun(db, s.id, "ingest", "transcribe", { stage: { stage: "transcribing", progress: 30 } });
    expect(ok).toBe(false);
    expect((await getPipelineRun(db, s.id))!.nextStep).toBe("download");
    expect((await getSession(db, s.id))!.stage).toBe("uploaded");
  });

  it("advance with a patch sets round and answers in the same update", async () => {
    await ensurePipelineRun(db, s.id, "ask_context");
    const answers = [{ question: "Who?", answer: "Ana" }];
    expect(await advancePipelineRun(db, s.id, "ask_context", "match_record_late", { round: 2, answers })).toBe(true);
    expect(await getPipelineRun(db, s.id)).toMatchObject({ nextStep: "match_record_late", round: 2, answers });
  });

  it("advance with a stage patch sets the session stage only when the step moved", async () => {
    await ensurePipelineRun(db, s.id, "download");
    expect(await advancePipelineRun(db, s.id, "download", "ingest", { stage: { stage: "preparing", progress: 10 } })).toBe(true);
    const after = await getSession(db, s.id);
    expect(after).toMatchObject({ stage: "preparing", progress: 10 });
  });

  it("a stage patch does not revive a failed session (the step still moves)", async () => {
    await ensurePipelineRun(db, s.id, "understand_context");
    await setStage(db, s.id, "failed", 55, "Boom");
    expect(await advancePipelineRun(db, s.id, "understand_context", "ask_context", { stage: { stage: "awaiting_context", progress: 55 } })).toBe(true);
    expect(await getSession(db, s.id)).toMatchObject({ stage: "failed", error: "Boom" });
    expect((await getPipelineRun(db, s.id))!.nextStep).toBe("ask_context");
  });

  it("deletePipelineRun removes the row; deleting a session cascades", async () => {
    await ensurePipelineRun(db, s.id, "download");
    await deletePipelineRun(db, s.id);
    expect(await getPipelineRun(db, s.id)).toBeNull();
    await ensurePipelineRun(db, s.id, "download");
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("DELETE FROM sessions WHERE id = $1", [s.id]);
    await pool.end();
    expect(await db.select().from(pipelineRuns).where(eq(pipelineRuns.sessionId, s.id))).toEqual([]);
  });
});
