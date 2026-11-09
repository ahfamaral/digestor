import { eq, sql } from "drizzle-orm";
import type { PipelineStep, Stage } from "../schemas.ts";
import type { Db } from "./client.ts";
import { setStage } from "./repo.ts";
import { pipelineRuns } from "./schema.ts";

export type PipelineRun = {
  sessionId: string;
  nextStep: PipelineStep;
  round: number;
  answers: { question: string; answer: string }[];
  updatedAt: Date;
};

export async function getPipelineRun(db: Db, sessionId: string): Promise<PipelineRun | null> {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.sessionId, sessionId));
  return row ?? null;
}

/** Creates the run at `firstStep` if the session has none, then returns it (an existing run keeps its position). */
export async function ensurePipelineRun(db: Db, sessionId: string, firstStep: PipelineStep): Promise<PipelineRun> {
  await db.insert(pipelineRuns).values({ sessionId, nextStep: firstStep }).onConflictDoNothing();
  return (await getPipelineRun(db, sessionId))!;
}

/**
 * Compare-and-set: moves the run `from` → `to` only if it is still at `from`. With `patch.stage` the session's
 * stage/progress is set in the same transaction, only when the step moved. Returns whether the step moved.
 */
export async function advancePipelineRun(
  db: Db,
  sessionId: string,
  from: PipelineStep,
  to: PipelineStep,
  patch?: { round?: number; answers?: PipelineRun["answers"]; stage?: { stage: Stage; progress: number } },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(pipelineRuns)
      .set({
        nextStep: to,
        updatedAt: sql`now()`,
        ...(patch?.round !== undefined ? { round: patch.round } : {}),
        ...(patch?.answers !== undefined ? { answers: patch.answers } : {}),
      })
      .where(sql`${pipelineRuns.sessionId} = ${sessionId} AND ${pipelineRuns.nextStep} = ${from}`)
      .returning({ sessionId: pipelineRuns.sessionId });
    if (rows.length === 0) return false;
    if (patch?.stage) await setStage(tx, sessionId, patch.stage.stage, patch.stage.progress);
    return true;
  });
}

export async function deletePipelineRun(db: Db, sessionId: string): Promise<void> {
  await db.delete(pipelineRuns).where(eq(pipelineRuns.sessionId, sessionId));
}
