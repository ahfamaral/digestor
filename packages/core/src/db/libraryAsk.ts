import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AskRole, LibraryAskMessage, LibraryAskSource, LibraryAskStatus } from "../personalTypes.ts";
import type { ContextCard } from "../schemas.ts";
import type { Db } from "./client.ts";
import { analysisVersions, contextCards, libraryAskMessages, sessions } from "./schema.ts";

// Ask across videos (`library_ask_messages`): the owner's conversation over every searchable video. Read-only, so
// unlike `ask_messages` there are no actions and no `waiting`.

export async function addLibraryAskMessage(
  db: Db,
  a: { ownerId: string; role: AskRole; text: string; status?: LibraryAskStatus; questionId?: string },
): Promise<LibraryAskMessage> {
  const [row] = await db.insert(libraryAskMessages).values(a).returning();
  return row!;
}

/**
 * A new question (`done`) and its `pending` answer pointing at it (`question_id`), in one transaction: the worker
 * answers exactly that question, even when two are sent at the same moment.
 */
export async function addLibraryQuestion(db: Db, ownerId: string, text: string): Promise<{ question: LibraryAskMessage; answer: LibraryAskMessage }> {
  return db.transaction(async (tx) => {
    // clock_timestamp(), not now(): now() is the transaction's start, so both rows would share it and list in any order.
    const at = sql`clock_timestamp()`;
    const [question] = await tx.insert(libraryAskMessages).values({ ownerId, role: "user", text, status: "done", createdAt: at, updatedAt: at }).returning();
    const [answer] = await tx
      .insert(libraryAskMessages)
      .values({ ownerId, role: "assistant", text: "", status: "pending", questionId: question!.id, createdAt: at, updatedAt: at })
      .returning();
    return { question: question!, answer: answer! };
  });
}

export async function getLibraryAskMessage(db: Db, id: string): Promise<LibraryAskMessage | null> {
  const [row] = await db.select().from(libraryAskMessages).where(eq(libraryAskMessages.id, id));
  return row ?? null;
}

/** The owner's conversation, oldest first (the newest `limit` messages). */
export async function listLibraryAskMessages(db: Db, ownerId: string, limit = 100): Promise<LibraryAskMessage[]> {
  const rows = await db
    .select()
    .from(libraryAskMessages)
    .where(eq(libraryAskMessages.ownerId, ownerId))
    .orderBy(desc(libraryAskMessages.createdAt), desc(libraryAskMessages.id))
    .limit(limit);
  return rows.reverse();
}

/** Removes messages; used to roll back a question whose job could not be queued. */
export async function deleteLibraryAskMessages(db: Db, ids: string[]): Promise<void> {
  if (ids.length > 0) await db.delete(libraryAskMessages).where(inArray(libraryAskMessages.id, ids));
}

/** Compare-and-set `pending` → `running` before the worker answers: true only for the caller that claimed it. */
export async function claimLibraryAskMessage(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(libraryAskMessages)
    .set({ status: "running" })
    .where(and(eq(libraryAskMessages.id, id), eq(libraryAskMessages.status, "pending")))
    .returning({ id: libraryAskMessages.id });
  return rows.length > 0;
}

/** `running` → `pending`: the attempt failed, pg-boss's retry may answer it again (nothing was changed: read-only). */
export async function releaseLibraryAskMessage(db: Db, id: string): Promise<void> {
  await db
    .update(libraryAskMessages)
    .set({ status: "pending" })
    .where(and(eq(libraryAskMessages.id, id), eq(libraryAskMessages.status, "running")));
}

export async function finishLibraryAskMessage(
  db: Db,
  id: string,
  a: { text: string; sources?: LibraryAskSource[] | null; toolCalls?: unknown; status: Exclude<LibraryAskStatus, "pending" | "running"> },
): Promise<LibraryAskMessage> {
  const [row] = await db
    .update(libraryAskMessages)
    .set({ text: a.text, sources: a.sources ?? null, toolCalls: a.toolCalls ?? null, status: a.status })
    .where(eq(libraryAskMessages.id, id))
    .returning();
  if (!row) throw new Error(`Library ask message not found: ${id}`);
  return row;
}

/** A video Ask across videos may search: the router reads its title, date, kind and summary. */
export interface LibraryCandidateRow {
  id: string;
  title: string;
  createdAt: Date;
  /** Spoken language (transcription's, or the one picked at upload). */
  language: string | null;
  /** The current analysis version's profile (null without one). */
  profile: string | null;
  card: ContextCard | null;
}

/**
 * The owner's `ready` sessions whose video (and with it the search index) hasn't been removed by retention, newest
 * first. Whether the Chroma collection really exists is the worker's check.
 */
export async function listLibraryCandidates(db: Db, ownerId: string, limit: number): Promise<LibraryCandidateRow[]> {
  return db
    .select({
      id: sessions.id,
      title: sessions.title,
      createdAt: sessions.createdAt,
      language: sessions.language,
      profile: analysisVersions.profile,
      card: contextCards.card,
    })
    .from(sessions)
    .leftJoin(contextCards, eq(contextCards.sessionId, sessions.id))
    .leftJoin(analysisVersions, and(eq(analysisVersions.sessionId, sessions.id), eq(analysisVersions.isCurrent, true)))
    .where(and(eq(sessions.ownerId, ownerId), eq(sessions.stage, "ready"), isNull(sessions.videoDeletedAt)))
    .orderBy(desc(sessions.createdAt), asc(sessions.id))
    .limit(limit);
}

/** Which of these sessions still exist (a reply's sources may outlive a deleted session). */
export async function existingSessionIds(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, ids));
  return new Set(rows.map((r) => r.id));
}
