import { and, eq, lt, sql } from "drizzle-orm";
import type { ClipOrigin, ClipStatus, ContextCard, ProposedClip, Transcript } from "../schemas.ts";
import type { Db } from "./client.ts";
import { clipEvents, clips, contextCards, sessions, transcripts, type Stage } from "./schema.ts";

export type Session = typeof sessions.$inferSelect;
export type Clip = typeof clips.$inferSelect;
export type Actor = "ai" | "user" | "copilot";

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
  const [row] = await db.update(sessions).set(rest).where(eq(sessions.id, id)).returning();
  if (!row) throw new Error(`Session not found: ${id}`);
  return row;
}

export async function setStage(db: Db, id: string, stage: Stage, progress: number, error?: string): Promise<void> {
  await db
    .update(sessions)
    .set({ stage, progress, error: error ?? null })
    .where(eq(sessions.id, id));
}

/** Atomic compare-and-set: moves the session `from` → `to` only if it is still in `from`. Returns whether a row changed. */
export async function transitionStage(db: Db, id: string, from: Stage, to: Stage, progress: number): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ stage: to, progress, error: null })
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

type ClipInsert = typeof clips.$inferInsert;

export async function replaceAiClips(db: Db, sessionId: string, tree: ProposedClip[]): Promise<Clip[]> {
  return db.transaction(async (tx) => {
    await tx
      .delete(clips)
      .where(and(eq(clips.sessionId, sessionId), eq(clips.origin, "ai"), eq(clips.status, "proposed")));

    const toValues = (c: Omit<ProposedClip, "children">, parentId: string | null): ClipInsert => ({
      sessionId,
      parentId,
      title: c.title,
      reason: c.reason,
      label: c.label,
      score: c.score,
      startMs: c.startMs,
      endMs: c.endMs,
      status: "proposed",
      origin: "ai",
    });
    const created: Clip[] = [];
    const log = async (rows: Clip[]) => {
      if (rows.length === 0) return;
      await tx.insert(clipEvents).values(
        rows.map((r) => ({
          clipId: r.id,
          actor: "ai" as const,
          kind: "create" as const,
          before: null,
          after: { startMs: r.startMs, endMs: r.endMs, status: r.status },
        })),
      );
    };

    for (const parent of tree) {
      const [p] = await tx.insert(clips).values(toValues(parent, null)).returning();
      const kids = parent.children.length
        ? await tx
            .insert(clips)
            .values(parent.children.map((k) => toValues(k, p!.id)))
            .returning()
        : [];
      await log([p!, ...kids]);
      created.push(p!, ...kids);
    }
    return created;
  });
}

export async function listClips(db: Db, sessionId: string): Promise<Clip[]> {
  const rows = await db.select().from(clips).where(eq(clips.sessionId, sessionId));
  const parents = rows.filter((c) => c.parentId === null).sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const out: Clip[] = [];
  for (const p of parents) {
    out.push(p);
    out.push(...rows.filter((c) => c.parentId === p.id).sort((a, b) => a.startMs - b.startMs));
  }
  return out;
}

export async function getClip(db: Db, id: string): Promise<Clip | null> {
  const [row] = await db.select().from(clips).where(eq(clips.id, id));
  return row ?? null;
}

export async function setClipStatus(db: Db, id: string, status: ClipStatus, actor: Actor): Promise<Clip> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(clips).where(eq(clips.id, id));
    if (!before) throw new Error(`Clip not found: ${id}`);
    const [row] = await tx.update(clips).set({ status, updatedAt: new Date() }).where(eq(clips.id, id)).returning();
    await tx.insert(clipEvents).values({
      clipId: id,
      actor,
      kind: "status",
      before: { status: before.status },
      after: { status },
    });
    return row!;
  });
}

export async function setClipBounds(
  db: Db,
  id: string,
  bounds: { startMs: number; endMs: number },
  actor: Actor,
): Promise<Clip> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(clips).where(eq(clips.id, id));
    if (!before) throw new Error(`Clip not found: ${id}`);
    let outOfBounds = before.outOfBounds;
    if (before.parentId) {
      const [parent] = await tx.select().from(clips).where(eq(clips.id, before.parentId));
      if (parent) outOfBounds = !(bounds.startMs >= parent.startMs && bounds.endMs <= parent.endMs);
    }
    const [row] = await tx
      .update(clips)
      .set({
        outOfBounds,
        startMs: bounds.startMs,
        endMs: bounds.endMs,
        renderStatus: before.renderStatus === "done" ? "stale" : before.renderStatus,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, id))
      .returning();
    await tx.insert(clipEvents).values({
      clipId: id,
      actor,
      kind: "bounds",
      before: { startMs: before.startMs, endMs: before.endMs },
      after: bounds,
    });
    await tx
      .update(clips)
      .set({
        outOfBounds: sql`NOT (${clips.startMs} >= ${bounds.startMs} AND ${clips.endMs} <= ${bounds.endMs})`,
      })
      .where(eq(clips.parentId, id));
    return row!;
  });
}

export async function setRenderState(
  db: Db,
  id: string,
  patch: Partial<Pick<Clip, "renderStatus" | "renderKey" | "srtKey" | "thumbKey">>,
): Promise<Clip> {
  const [row] = await db
    .update(clips)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(clips.id, id))
    .returning();
  if (!row) throw new Error(`Clip not found: ${id}`);
  return row;
}

export function setClipThumb(db: Db, id: string, key: string): Promise<Clip> {
  return setRenderState(db, id, { thumbKey: key });
}
