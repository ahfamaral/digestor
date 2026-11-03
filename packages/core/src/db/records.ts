import { and, eq } from "drizzle-orm";
import type { RecordRef, RecordStatus } from "../recordRef.ts";
import type { Db } from "./client.ts";
import { sessionRecords } from "./schema.ts";

export type SessionRecord = {
  sessionId: string;
  chamber: "senado" | "camara";
  ref: RecordRef;
  status: RecordStatus;
  error: string | null;
  rawKey: string | null;
  fetchedAt: Date | null;
  updatedAt: Date;
};

const toRecord = (r: typeof sessionRecords.$inferSelect): SessionRecord => ({ ...r });

/** Links (or re-links) the session's record: one row per session, back to `pending` with the old result cleared. */
export async function linkRecord(db: Db, sessionId: string, ref: RecordRef): Promise<void> {
  const fresh = { chamber: ref.chamber, ref, status: "pending" as const, error: null, rawKey: null, fetchedAt: null, updatedAt: new Date() };
  await db.insert(sessionRecords).values({ sessionId, ...fresh }).onConflictDoUpdate({ target: sessionRecords.sessionId, set: fresh });
}

/** Compare-and-set `pending` → `running`: the row, or null when it isn't `pending` (another run has it, or it is done). */
export async function claimRecordFetch(db: Db, sessionId: string): Promise<SessionRecord | null> {
  const [row] = await db
    .update(sessionRecords)
    .set({ status: "running" })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "pending")))
    .returning();
  return row ? toRecord(row) : null;
}

/** `running` → `matched`; false when the row isn't running any more (it was re-linked meanwhile). */
export async function finishRecordFetch(db: Db, sessionId: string, a: { rawKey: string }): Promise<boolean> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "matched", error: null, rawKey: a.rawKey, fetchedAt: new Date() })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "running")))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** Marks the row `failed` with a friendly sentence, unless it was re-linked (`pending`) meanwhile. */
export async function failRecordFetch(db: Db, sessionId: string, message: string): Promise<void> {
  await db
    .update(sessionRecords)
    .set({ status: "failed", error: message })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "running")));
}

export async function getSessionRecord(db: Db, sessionId: string): Promise<SessionRecord | null> {
  const [row] = await db.select().from(sessionRecords).where(eq(sessionRecords.sessionId, sessionId));
  return row ? toRecord(row) : null;
}
