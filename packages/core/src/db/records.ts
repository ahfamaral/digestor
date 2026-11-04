import { and, eq, isNull, sql } from "drizzle-orm";
import type { ChamberId } from "../chambers.ts";
import type { RecordRef, RecordStatus } from "../recordRef.ts";
import type { Db } from "./client.ts";
import { attributions, sessionRecords } from "./schema.ts";

export type SessionRecord = {
  sessionId: string;
  chamber: ChamberId;
  ref: RecordRef;
  status: RecordStatus;
  error: string | null;
  rawKey: string | null;
  fetchedAt: Date | null;
  retryAt: Date | null;
  linkedAt: Date;
  updatedAt: Date;
};

const toRecord = (r: typeof sessionRecords.$inferSelect): SessionRecord => ({ ...r });

const sortedJson = (o: object) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y))));

/**
 * Links (or re-links) the session's record: one row per session, back to `pending` with the old result cleared. A
 * link to a different record than the stored one also supersedes the session's current `record` attributions
 * (rejections a human made stay), in the same transaction under the session's advisory lock, so a failed or
 * in-flight re-link never leaves the previous record's names visible.
 */
export async function linkRecord(db: Db, sessionId: string, ref: RecordRef): Promise<void> {
  const fresh = { chamber: ref.chamber, ref, status: "pending" as const, error: null, rawKey: null, fetchedAt: null, retryAt: null, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
    const [existing] = await tx.select({ ref: sessionRecords.ref }).from(sessionRecords).where(eq(sessionRecords.sessionId, sessionId));
    const changed = !existing || sortedJson(existing.ref) !== sortedJson(ref);
    // A new row gets linked_at from its default; a re-link keeps it unless the ref changed.
    await tx.insert(sessionRecords).values({ sessionId, ...fresh }).onConflictDoUpdate({
      target: sessionRecords.sessionId,
      // linked_at is the database clock, so window math in SQL and in the worker agrees.
      set: changed ? { ...fresh, linkedAt: sql`now()` } : fresh,
    });
    if (existing && changed) {
      await tx
        .update(attributions)
        .set({ supersededAt: sql`now()` })
        .where(and(eq(attributions.sessionId, sessionId), eq(attributions.source, "record"), isNull(attributions.supersededAt), sql`${attributions.status} <> 'rejected'`));
    }
  });
}

/**
 * Stores a suggested record (from the YouTube details) only when the session has no record row at all: a record linked
 * at upload, a fetched one, and a suggestion already there all stay. False when a row exists.
 */
export async function suggestRecordRow(db: Db, sessionId: string, ref: RecordRef): Promise<boolean> {
  const rows = await db
    .insert(sessionRecords)
    .values({ sessionId, chamber: ref.chamber, ref, status: "suggested" })
    .onConflictDoNothing({ target: sessionRecords.sessionId })
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
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

/** The row still holds this ref (jsonb equality, key order aside): a re-link to another record changes it. */
const sameRef = (ref: RecordRef | undefined) => (ref ? sql`${sessionRecords.ref} = ${JSON.stringify(ref)}::jsonb` : undefined);

/** `suggested` → `pending` only while the row still holds this ref (what the journalist saw). */
export async function acceptSuggestedRecord(db: Db, sessionId: string, ref: RecordRef): Promise<boolean> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "pending", error: null, updatedAt: new Date(), linkedAt: sql`now()` }) // accepting is the link: windows count from here
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "suggested"), sameRef(ref)))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** `pending` → `suggested` for this ref: undoes an accept whose job could not be queued. False when the row moved on. */
export async function revertAcceptedRecord(db: Db, sessionId: string, ref: RecordRef): Promise<boolean> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "suggested", updatedAt: new Date() })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "pending"), sameRef(ref)))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** Deletes the row only when it is `suggested` with this ref. */
export async function dismissSuggestedRecord(db: Db, sessionId: string, ref: RecordRef): Promise<boolean> {
  const rows = await db
    .delete(sessionRecords)
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "suggested"), sameRef(ref)))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** `running` → `matched`; false when the row isn't running any more or (with `ref`) was re-linked to another record meanwhile. */
export async function finishRecordFetch(db: Db, sessionId: string, a: { rawKey: string; ref?: RecordRef }): Promise<boolean> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "matched", error: null, rawKey: a.rawKey, fetchedAt: new Date() })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "running"), sameRef(a.ref)))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** `running` → `pending` (a transient failure handing the row to a retry); false when it isn't running or was re-linked to another record meanwhile. */
export async function releaseRecordFetch(db: Db, sessionId: string, ref?: RecordRef): Promise<boolean> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "pending" })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "running"), sameRef(ref)))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** Marks the row `failed` with a friendly sentence, unless it was re-linked meanwhile (no longer `running`, or, with `ref`, another record). */
export async function failRecordFetch(db: Db, sessionId: string, message: string, ref?: RecordRef): Promise<void> {
  await db
    .update(sessionRecords)
    .set({ status: "failed", error: message })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, "running"), sameRef(ref)));
}

export async function getSessionRecord(db: Db, sessionId: string): Promise<SessionRecord | null> {
  const [row] = await db.select().from(sessionRecords).where(eq(sessionRecords.sessionId, sessionId));
  return row ? toRecord(row) : null;
}

/** `running` → `waiting` for this ref (the house hasn't published it yet): the row is picked up again at `retryAt`. False when it isn't running or was re-linked meanwhile. */
export async function waitRecordFetch(db: Db, sessionId: string, ref: RecordRef, retryAt: Date, message?: string): Promise<boolean> {
  return setWaiting(db, sessionId, "running", ref, retryAt, message);
}

/** `pending` → `waiting` (a retry job that could not be sent): same ref only. */
export async function requeueRecordRetry(db: Db, sessionId: string, ref: RecordRef, retryAt: Date): Promise<boolean> {
  return setWaiting(db, sessionId, "pending", ref, retryAt);
}

async function setWaiting(db: Db, sessionId: string, from: "running" | "pending", ref: RecordRef, retryAt: Date, message?: string): Promise<boolean> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "waiting", retryAt, updatedAt: new Date(), ...(message === undefined ? {} : { error: message }) })
    .where(and(eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.status, from), sameRef(ref)))
    .returning({ id: sessionRecords.sessionId });
  return rows.length > 0;
}

/** Compare-and-set `waiting` → `pending` for every row due at `now`; the session ids and refs it claimed (each exactly once, however many callers race; the ref is the one claimed, so a later re-link is never mistaken for it). */
export async function claimDueRecordRetries(db: Db, now: Date): Promise<{ sessionId: string; ref: RecordRef }[]> {
  const rows = await db
    .update(sessionRecords)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(sessionRecords.status, "waiting"), sql`${sessionRecords.retryAt} <= ${now.toISOString()}::timestamptz`))
    .returning({ sessionId: sessionRecords.sessionId, ref: sessionRecords.ref });
  return rows;
}
