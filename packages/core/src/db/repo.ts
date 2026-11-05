import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { ContextCard, Transcript } from "../schemas.ts";
import type { Db } from "./client.ts";
import { clips, contextCards, sessions, transcripts, type Stage } from "./schema.ts";

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
    audioOnlyAck?: boolean;
    languageOverride?: string | null;
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
      audioOnlyAck: input.audioOnlyAck ?? false,
      languageOverride: input.languageOverride ?? null,
    })
    .returning();
  return row!;
}

export async function listExpiredSessions(db: Db, olderThanDays: number): Promise<Session[]> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  return db.select().from(sessions).where(lt(sessions.createdAt, cutoff));
}

/** Sessions created more than `olderThanDays` ago whose source video hasn't been removed yet. */
export async function listSessionsWithExpiredVideo(db: Db, olderThanDays: number): Promise<Session[]> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  return db.select().from(sessions).where(and(lt(sessions.createdAt, cutoff), isNull(sessions.videoDeletedAt)));
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

export interface SessionSummary {
  id: string;
  title: string;
  language: string | null;
  profile: string | null;
  stage: Stage;
  source: "upload" | "youtube";
  error: string | null;
  videoRemoved: boolean;
  lastActivityAt: Date;
  renderedClips: number;
}

/** The owner's sessions, newest activity first (the session's own update or its latest clip update). */
export async function listSessionSummaries(db: Db, ownerId: string, limit = 50): Promise<SessionSummary[]> {
  const agg = db
    .select({
      sessionId: clips.sessionId,
      lastClipAt: sql<Date | null>`max(${clips.updatedAt})`.as("last_clip_at"),
      rendered: sql<number>`count(*) filter (where ${clips.renderStatus} = 'done')::int`.as("rendered"),
    })
    .from(clips)
    .where(and(eq(clips.ownerId, ownerId), isNull(clips.deletedAt)))
    .groupBy(clips.sessionId)
    .as("clip_agg");
  const activity = sql<Date>`greatest(${sessions.updatedAt}, ${agg.lastClipAt})`;
  const rows = await db
    .select({
      id: sessions.id, title: sessions.title, language: sessions.language, profile: sessions.profile,
      stage: sessions.stage, source: sessions.source, error: sessions.error, videoDeletedAt: sessions.videoDeletedAt,
      lastActivityAt: activity.mapWith(sessions.updatedAt), rendered: agg.rendered,
    })
    .from(sessions)
    .leftJoin(agg, eq(agg.sessionId, sessions.id))
    .orderBy(desc(activity))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, title: r.title, language: r.language, profile: r.profile, stage: r.stage, source: r.source, error: r.error,
    videoRemoved: r.videoDeletedAt !== null, lastActivityAt: r.lastActivityAt, renderedClips: r.rendered ?? 0,
  }));
}
