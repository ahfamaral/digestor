import { and, eq, inArray, sql } from "drizzle-orm";
import { isProxyReady } from "../schemas.ts";
import type { Db } from "./client.ts";
import { sessions } from "./schema.ts";

export const PREVIEW_FAILED = "The video preview couldn't be prepared. Please try again.";

/**
 * Asks for the preview copy: `pending`, unless it is already `running` or `done` (a re-run of the ingest node must not
 * undo the job's progress). A `failed` or unset copy starts over.
 */
export async function requestProxy(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ proxyStatus: "pending", updatedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), sql`(${sessions.proxyStatus} is null or ${sessions.proxyStatus} in ('pending', 'failed'))`));
}

/** Compare-and-set `pending` → `running`; with `takeover` (a retry) a `running` row is taken over too. False when there was nothing to claim. */
export async function claimProxy(db: Db, sessionId: string, opts: { takeover?: boolean } = {}): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ proxyStatus: "running", updatedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), inArray(sessions.proxyStatus, opts.takeover ? ["pending", "running"] : ["pending"])))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** `running` → `done` with the `proxyKey`, in one update; false when the row isn't running any more. */
export async function finishProxy(db: Db, sessionId: string, proxyKey: string): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ proxyStatus: "done", proxyKey, updatedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.proxyStatus, "running")))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** `pending`/`running` → `failed` (deterministic failure, the last attempt, or the sweep). */
export async function failProxy(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ proxyStatus: "failed", updatedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), inArray(sessions.proxyStatus, ["pending", "running"])));
}

/**
 * The join of analysis and preview copy: a session in `preparing_preview` becomes `ready` once the copy is ready, or
 * `failed` when the copy failed. Both sides call it after writing their own half, so whichever finishes last closes it;
 * the advisory lock makes the check and the write one step.
 */
export async function settlePreview(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
    const [s] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!s || s.stage !== "preparing_preview") return;
    // The stage guard again in the write: the sweep and `setStage` don't take the advisory lock.
    const still = and(eq(sessions.id, sessionId), eq(sessions.stage, "preparing_preview"));
    if (isProxyReady(s)) await tx.update(sessions).set({ stage: "ready", progress: 100, error: null, updatedAt: sql`now()` }).where(still);
    else if (s.proxyStatus === "failed") await tx.update(sessions).set({ stage: "failed", error: PREVIEW_FAILED, updatedAt: sql`now()` }).where(still);
  });
}
