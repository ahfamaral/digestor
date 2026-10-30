import { and, eq, lt, sql } from "drizzle-orm";
import type { ContextCard, Transcript } from "../schemas.ts";
import type { Db } from "./client.ts";
import { contextCards, sessions, transcripts, type Stage } from "./schema.ts";

export type Session = typeof sessions.$inferSelect;

export async function createSession(
  db: Db,
  input: {
    id?: string;
    title: string;
    source: "upload" | "youtube";
    sourceUrl?: string;
    originalKey?: string;
    hint?: string | null;
  },
): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      source: input.source,
      sourceUrl: input.sourceUrl ?? null,
      originalKey: input.originalKey ?? null,
      hint: input.hint ?? null,
    })
    .returning();
  return row!;
}

export async function listExpiredSessions(db: Db, olderThanDays: number): Promise<Session[]> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  return db.select().from(sessions).where(lt(sessions.createdAt, cutoff));
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function getSession(db: Db, id: string): Promise<Session | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row ?? null;
}

export async function updateSession(db: Db, id: string, patch: Partial<Session>): Promise<Session> {
  const { id: _id, ...rest } = patch;
  const [row] = await db.update(sessions).set({ ...rest, updatedAt: sql`now()` }).where(eq(sessions.id, id)).returning();
  if (!row) throw new Error(`Session not found: ${id}`);
  return row;
}

export async function setStage(db: Db, id: string, stage: Stage, progress: number, error?: string): Promise<void> {
  await db
    .update(sessions)
    .set({ stage, progress, error: error ?? null, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
}

/** Atomic compare-and-set: moves the session `from` → `to` only if it is still in `from`. Returns whether a row changed. */
export async function transitionStage(db: Db, id: string, from: Stage, to: Stage, progress: number): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ stage: to, progress, error: null, updatedAt: sql`now()` })
    .where(and(eq(sessions.id, id), eq(sessions.stage, from)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function saveTranscript(db: Db, id: string, t: Transcript): Promise<void> {
  const values = {
    language: t.language,
    languageConfidence: t.languageConfidence,
    durationMs: t.durationMs,
    words: t.words,
  };
  await db
    .insert(transcripts)
    .values({ sessionId: id, ...values })
    .onConflictDoUpdate({ target: transcripts.sessionId, set: values });
}

export async function getTranscript(db: Db, id: string): Promise<Transcript | null> {
  const [row] = await db.select().from(transcripts).where(eq(transcripts.sessionId, id));
  if (!row) return null;
  return {
    language: row.language,
    languageConfidence: row.languageConfidence,
    durationMs: row.durationMs,
    words: row.words,
  };
}

export async function saveContextCard(db: Db, id: string, card: ContextCard, round: number): Promise<void> {
  await db
    .insert(contextCards)
    .values({ sessionId: id, card, round })
    .onConflictDoUpdate({ target: contextCards.sessionId, set: { card, round, updatedAt: new Date() } });
}

export async function getContextCard(db: Db, id: string): Promise<{ card: ContextCard; round: number } | null> {
  const [row] = await db.select().from(contextCards).where(eq(contextCards.sessionId, id));
  return row ? { card: row.card, round: row.round } : null;
}
