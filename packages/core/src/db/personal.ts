import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MomentWithHighlights } from "../analysisTypes.ts";
import type {
  AskActionKind, AskAction, AskMessage, AskMessageStatus, AskMessageWithActions, AskRole, Clip, ClipActor, ClipFormat,
  ClipEvent, ProblemReport, ProblemTargetKind, RenderStatus, SelectionStatus, Track, TrackCue, TrackStatus,
} from "../personalTypes.ts";
import { GRANULARITY, type Granularity } from "../profiles.ts";
import type { Db } from "./client.ts";
import {
  askActions, askMessages, analysisVersions, clipEvents, clips, moments, problemReports, selections, subtitleTracks,
  topics,
} from "./schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

// ---------------------------------------------------------------- personal moments

function granularityFor(lenMs: number): Granularity {
  const ids = Object.keys(GRANULARITY) as Granularity[];
  const dist = (r: [number, number]) => (lenMs < r[0] ? r[0] - lenMs : lenMs > r[1] ? lenMs - r[1] : 0);
  const inAccept = ids.filter((g) => dist(GRANULARITY[g].acceptMs) === 0);
  const pool = inAccept.length ? inAccept : ids;
  const key = (g: Granularity) => (inAccept.length ? dist(GRANULARITY[g].targetMs) : dist(GRANULARITY[g].acceptMs));
  return pool.reduce((best, g) => (key(g) < key(best) ? g : best));
}

export async function createPersonalMoment(
  db: Db,
  a: { analysisId: string; ownerId: string; startMs: number; endMs: number; title: string; origin: "ask" | "user" },
): Promise<MomentWithHighlights> {
  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.analysisId, a.analysisId), sql`${topics.startMs} <= ${a.startMs}`, sql`${topics.endMs} > ${a.startMs}`))
    .limit(1);
  const [row] = await db
    .insert(moments)
    .values({
      analysisId: a.analysisId,
      topicId: topic?.id ?? null,
      granularity: granularityFor(a.endMs - a.startMs),
      startMs: a.startMs,
      endMs: a.endMs,
      title: a.title,
      why: "",
      relevance: 0,
      ownerId: a.ownerId,
      origin: a.origin,
    })
    .returning();
  return { ...row!, highlights: [] };
}

export async function listPersonalMoments(db: Db, ownerId: string, analysisId: string): Promise<MomentWithHighlights[]> {
  const rows = await db
    .select()
    .from(moments)
    .where(and(eq(moments.analysisId, analysisId), eq(moments.ownerId, ownerId)))
    .orderBy(asc(moments.startMs), asc(moments.id));
  return rows.map((r) => ({ ...r, highlights: [] }));
}

// ---------------------------------------------------------------- selections

/** `null` removes the row ("proposed"). */
export async function setSelection(db: Db, ownerId: string, momentId: string, status: SelectionStatus | null): Promise<void> {
  if (status === null) {
    await db.delete(selections).where(and(eq(selections.ownerId, ownerId), eq(selections.momentId, momentId)));
    return;
  }
  await db
    .insert(selections)
    .values({ ownerId, momentId, status })
    .onConflictDoUpdate({ target: [selections.ownerId, selections.momentId], set: { status, updatedAt: new Date() } });
}

export async function listSelections(db: Db, ownerId: string, sessionId: string): Promise<Record<string, SelectionStatus>> {
  const rows = await db
    .select({ momentId: selections.momentId, status: selections.status })
    .from(selections)
    .innerJoin(moments, eq(moments.id, selections.momentId))
    .innerJoin(analysisVersions, eq(analysisVersions.id, moments.analysisId))
    .where(and(eq(selections.ownerId, ownerId), eq(analysisVersions.sessionId, sessionId)));
  return Object.fromEntries(rows.map((r) => [r.momentId, r.status]));
}

// ---------------------------------------------------------------- clips

export type ClipPatch = Partial<
  Pick<Clip, "startMs" | "endMs" | "format" | "cropOffset" | "credit" | "noCreditNeeded" | "warningsAck" | "protectedAck">
>;

const alive = isNull(clips.deletedAt);

async function lockClip(tx: Tx, id: string): Promise<Clip | null> {
  const [row] = await tx.select().from(clips).where(eq(clips.id, id)).for("update");
  return row ?? null;
}

/** A bounds/format/crop change makes a finished render and its burned subtitle tracks out of date. */
async function staleIfDone(tx: Tx, clipId: string): Promise<void> {
  await tx
    .update(clips)
    .set({ renderStatus: "stale" })
    .where(and(eq(clips.id, clipId), eq(clips.renderStatus, "done")));
  await tx
    .update(subtitleTracks)
    .set({ burnStatus: "stale" })
    .where(and(eq(subtitleTracks.clipId, clipId), eq(subtitleTracks.burnStatus, "done")));
}

export async function createClip(
  db: Db,
  a: { sessionId: string; ownerId: string; momentId?: string | null; startMs: number; endMs: number; actor: ClipActor },
): Promise<Clip> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(clips)
      .values({ sessionId: a.sessionId, ownerId: a.ownerId, momentId: a.momentId ?? null, startMs: a.startMs, endMs: a.endMs })
      .returning();
    await tx.insert(clipEvents).values({
      clipId: row!.id,
      actor: a.actor,
      kind: "create",
      before: null,
      after: { startMs: a.startMs, endMs: a.endMs, momentId: a.momentId ?? null },
    });
    return row!;
  });
}

export async function listClips(db: Db, ownerId: string, sessionId: string): Promise<Clip[]> {
  return db
    .select()
    .from(clips)
    .where(and(eq(clips.ownerId, ownerId), eq(clips.sessionId, sessionId), alive))
    .orderBy(asc(clips.startMs), asc(clips.createdAt));
}

/** Deleted clips are not returned. */
export async function getClip(db: Db, id: string): Promise<Clip | null> {
  const [row] = await db.select().from(clips).where(and(eq(clips.id, id), alive));
  return row ?? null;
}

export async function updateClip(db: Db, id: string, patch: ClipPatch, actor: ClipActor): Promise<Clip> {
  return db.transaction(async (tx) => {
    const before = await lockClip(tx, id);
    if (!before || before.deletedAt) throw new Error(`Clip not found: ${id}`);
    const changed = <K extends keyof ClipPatch>(k: K) => patch[k] !== undefined && patch[k] !== before[k];
    const boundsChanged = changed("startMs") || changed("endMs");
    const formatChanged = changed("format") || changed("cropOffset");
    const creditChanged = changed("credit") || changed("noCreditNeeded");
    const [row] = await tx
      .update(clips)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(clips.id, id))
      .returning();
    if (boundsChanged) {
      await tx.insert(clipEvents).values({
        clipId: id,
        actor,
        kind: "bounds",
        before: { startMs: before.startMs, endMs: before.endMs },
        after: { startMs: row!.startMs, endMs: row!.endMs },
      });
    }
    if (formatChanged) {
      await tx.insert(clipEvents).values({
        clipId: id,
        actor,
        kind: "format",
        before: { format: before.format, cropOffset: before.cropOffset },
        after: { format: row!.format, cropOffset: row!.cropOffset },
      });
    }
    if (boundsChanged || formatChanged || creditChanged) {
      await staleIfDone(tx, id);
      const [fresh] = await tx.select().from(clips).where(eq(clips.id, id));
      return fresh!;
    }
    return row!;
  });
}

/** Soft delete: the row and its events stay so `undoLastEvent` can restore it. */
export async function deleteClip(db: Db, id: string, actor: ClipActor): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await lockClip(tx, id);
    if (!before || before.deletedAt) return;
    await tx.update(clips).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(clips.id, id));
    await tx.insert(clipEvents).values({ clipId: id, actor, kind: "delete", before: null, after: null });
  });
}

/**
 * Reverts the most recent not-undone event. Returns the clip after the revert (its `deletedAt` is set when the
 * creation was undone), or null when there was nothing to undo.
 */
export async function undoLastEvent(db: Db, clipId: string): Promise<Clip | null> {
  return db.transaction(async (tx) => {
    const clip = await lockClip(tx, clipId);
    if (!clip) return null;
    const [ev] = await tx
      .select()
      .from(clipEvents)
      .where(and(eq(clipEvents.clipId, clipId), isNull(clipEvents.undoneAt)))
      .orderBy(desc(clipEvents.id))
      .limit(1);
    if (!ev) return null;
    const now = new Date();
    let set: Partial<typeof clips.$inferInsert> = { updatedAt: now };
    if (ev.kind === "bounds" || ev.kind === "format") {
      set = { ...set, ...(ev.before as object) };
    } else if (ev.kind === "create") {
      set = { ...set, deletedAt: now };
    } else {
      set = { ...set, deletedAt: null };
    }
    await tx.update(clips).set(set).where(eq(clips.id, clipId));
    await tx.update(clipEvents).set({ undoneAt: now }).where(eq(clipEvents.id, ev.id));
    if (ev.kind === "bounds" || ev.kind === "format") await staleIfDone(tx, clipId);
    const [fresh] = await tx.select().from(clips).where(eq(clips.id, clipId));
    return fresh!;
  });
}

export async function listClipEvents(db: Db, clipId: string): Promise<ClipEvent[]> {
  return db.select().from(clipEvents).where(eq(clipEvents.clipId, clipId)).orderBy(asc(clipEvents.id));
}

/** Worker progress/failure markers (`rendering`, `failed`). */
export async function setClipRenderStatus(db: Db, id: string, status: RenderStatus): Promise<void> {
  await db.update(clips).set({ renderStatus: status, updatedAt: new Date() }).where(and(eq(clips.id, id), alive));
}

/** Atomic claim before enqueueing a render: `queued` only from none, failed or stale. */
export async function claimClipRender(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(clips)
    .set({ renderStatus: "queued", updatedAt: new Date() })
    .where(and(eq(clips.id, id), alive, inArray(clips.renderStatus, ["none", "failed", "stale"])))
    .returning({ id: clips.id });
  return rows.length > 0;
}

/**
 * Records a finished render in one statement: `done` only if bounds, format, crop and credit are still exactly what was
 * rendered, otherwise `stale`. The key is stored either way. Null when the clip no longer exists.
 */
export async function finishClipRender(
  db: Db,
  id: string,
  rendered: { startMs: number; endMs: number; format: ClipFormat; cropOffset: number; credit: string | null },
  keys: { renderKey: string },
): Promise<"done" | "stale" | null> {
  const [row] = await db
    .update(clips)
    .set({
      renderKey: keys.renderKey,
      renderStatus: sql`CASE WHEN ${clips.startMs} = ${rendered.startMs} AND ${clips.endMs} = ${rendered.endMs} AND ${clips.format} = ${rendered.format} AND ${clips.cropOffset} = ${rendered.cropOffset} AND ${clips.credit} IS NOT DISTINCT FROM ${rendered.credit}::text THEN 'done' ELSE 'stale' END`,
      updatedAt: new Date(),
    })
    .where(and(eq(clips.id, id), alive))
    .returning({ renderStatus: clips.renderStatus });
  return row ? (row.renderStatus as "done" | "stale") : null;
}

// ---------------------------------------------------------------- subtitle tracks

/** What a burned-in render depends on: the cue texts plus the clip geometry and credit. */
export function burnSignature(
  track: { cues: TrackCue[] },
  clip: { startMs: number; endMs: number; format: ClipFormat; cropOffset: number; credit: string | null },
): string {
  const { startMs, endMs, format, cropOffset, credit } = clip;
  return createHash("sha1")
    .update(JSON.stringify({ texts: track.cues.map((c) => c.text), startMs, endMs, format, cropOffset, credit }))
    .digest("hex");
}

export async function getTrack(db: Db, id: string): Promise<Track | null> {
  const [row] = await db.select().from(subtitleTracks).where(eq(subtitleTracks.id, id));
  return row ?? null;
}

export async function listTracks(db: Db, clipId: string): Promise<Track[]> {
  return db.select().from(subtitleTracks).where(eq(subtitleTracks.clipId, clipId)).orderBy(asc(subtitleTracks.language));
}

/** Null if the clip already has a track in this language. */
export async function createTrack(db: Db, clipId: string, language: string): Promise<Track | null> {
  const [row] = await db.insert(subtitleTracks).values({ clipId, language }).onConflictDoNothing().returning();
  return row ?? null;
}

async function lockTrack(tx: Tx, id: string): Promise<Track> {
  const [row] = await tx.select().from(subtitleTracks).where(eq(subtitleTracks.id, id)).for("update");
  if (!row) throw new Error(`Track not found: ${id}`);
  return row;
}

export async function setTrackCues(db: Db, id: string, cues: TrackCue[], status: TrackStatus): Promise<Track> {
  const [row] = await db
    .update(subtitleTracks)
    .set({
      cues,
      status,
      error: null,
      approvedAt: null,
      burnStatus: sql`CASE WHEN ${subtitleTracks.burnStatus} = 'done' THEN 'stale' ELSE ${subtitleTracks.burnStatus} END`,
    })
    .where(eq(subtitleTracks.id, id))
    .returning();
  if (!row) throw new Error(`Track not found: ${id}`);
  return row;
}

/** Marks a track that is still `preparing` as failed with a user-facing message; a ready track is never touched. */
export async function failTrack(db: Db, id: string, message: string): Promise<boolean> {
  const rows = await db
    .update(subtitleTracks)
    .set({ status: "failed", error: message })
    .where(and(eq(subtitleTracks.id, id), eq(subtitleTracks.status, "preparing")))
    .returning({ id: subtitleTracks.id });
  return rows.length > 0;
}

export async function setTrackFiles(db: Db, id: string, keys: { srtKey: string; vttKey: string }): Promise<void> {
  await db.update(subtitleTracks).set(keys).where(eq(subtitleTracks.id, id));
}

/** Clears approval, recomputes `missing`, and outdates a finished burn. */
export async function editTrackCues(db: Db, id: string, edits: { i: number; text: string }[]): Promise<Track> {
  return db.transaction(async (tx) => {
    const track = await lockTrack(tx, id);
    const cues = track.cues.map((c) => ({ ...c }));
    for (const e of edits) {
      const c = cues[e.i];
      if (c) {
        c.text = e.text;
        c.missing = e.text.trim() === "";
      }
    }
    const [row] = await tx
      .update(subtitleTracks)
      .set({
        cues,
        approvedAt: null,
        burnStatus: track.burnStatus === "done" ? "stale" : track.burnStatus,
      })
      .where(eq(subtitleTracks.id, id))
      .returning();
    return row!;
  });
}

export async function approveTrack(db: Db, id: string): Promise<"ok" | "missing_cues"> {
  return db.transaction(async (tx) => {
    const track = await lockTrack(tx, id);
    if (track.cues.length === 0 || track.cues.some((c) => c.missing || c.text.trim() === "")) return "missing_cues";
    await tx.update(subtitleTracks).set({ approvedAt: new Date() }).where(eq(subtitleTracks.id, id));
    return "ok";
  });
}

/** Burned-in versions exist only for approved tracks. */
export async function claimTrackBurn(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(subtitleTracks)
    .set({ burnStatus: "queued" })
    .where(
      and(
        eq(subtitleTracks.id, id),
        sql`${subtitleTracks.approvedAt} is not null`,
        sql`exists (select 1 from ${clips} where ${clips.id} = ${subtitleTracks.clipId} and ${clips.deletedAt} is null)`,
        inArray(subtitleTracks.burnStatus, ["none", "failed", "stale"]),
      ),
    )
    .returning({ id: subtitleTracks.id });
  return rows.length > 0;
}

export async function setTrackBurnStatus(db: Db, id: string, status: RenderStatus): Promise<void> {
  await db.update(subtitleTracks).set({ burnStatus: status }).where(eq(subtitleTracks.id, id));
}

/**
 * `done` only if the track's cues and the clip's geometry/credit still match the signature the burn was made from;
 * the key is stored either way. Null when the track is missing or its clip was deleted.
 */
export async function finishTrackBurn(
  db: Db,
  id: string,
  signature: string,
  key: string,
): Promise<"done" | "stale" | null> {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ clipId: subtitleTracks.clipId }).from(subtitleTracks).where(eq(subtitleTracks.id, id));
    if (!peek) return null;
    const clip = await lockClip(tx, peek.clipId); // same order as updateClip: clip, then track
    const [track] = await tx.select().from(subtitleTracks).where(eq(subtitleTracks.id, id)).for("update");
    if (!clip || clip.deletedAt || !track) return null;
    const status = burnSignature(track, clip) === signature ? "done" : "stale";
    await tx.update(subtitleTracks).set({ burnKey: key, burnStatus: status }).where(eq(subtitleTracks.id, id));
    return status;
  });
}

// ---------------------------------------------------------------- ask

export async function addAskMessage(
  db: Db,
  a: { sessionId: string; ownerId: string; role: AskRole; text: string; status?: AskMessageStatus },
): Promise<AskMessage> {
  const [row] = await db.insert(askMessages).values(a).returning();
  return row!;
}

export async function finishAskMessage(
  db: Db,
  id: string,
  a: { text: string; toolCalls?: unknown; status: Exclude<AskMessageStatus, "pending"> },
): Promise<AskMessage> {
  const [row] = await db
    .update(askMessages)
    .set({ text: a.text, toolCalls: a.toolCalls ?? null, status: a.status })
    .where(eq(askMessages.id, id))
    .returning();
  if (!row) throw new Error(`Ask message not found: ${id}`);
  return row;
}

export async function listAskMessages(db: Db, ownerId: string, sessionId: string): Promise<AskMessageWithActions[]> {
  const msgs = await db
    .select()
    .from(askMessages)
    .where(and(eq(askMessages.ownerId, ownerId), eq(askMessages.sessionId, sessionId)))
    .orderBy(asc(askMessages.createdAt), asc(askMessages.id));
  if (msgs.length === 0) return [];
  const actions = await db
    .select()
    .from(askActions)
    .where(inArray(askActions.messageId, msgs.map((m) => m.id)));
  return msgs.map((m) => ({ ...m, actions: actions.filter((a) => a.messageId === m.id) }));
}

export async function createAskAction(
  db: Db,
  a: { messageId: string; kind: AskActionKind; payload: unknown },
): Promise<AskAction> {
  const [row] = await db.insert(askActions).values(a).returning();
  return row!;
}

/** Compare-and-set from `pending`: true only for the caller that resolved it. */
export async function resolveAskAction(db: Db, id: string, status: "confirmed" | "dismissed"): Promise<boolean> {
  const rows = await db
    .update(askActions)
    .set({ status })
    .where(and(eq(askActions.id, id), eq(askActions.status, "pending")))
    .returning({ id: askActions.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------- problem reports

export async function addProblemReport(
  db: Db,
  a: { ownerId: string; sessionId: string; targetKind: ProblemTargetKind; targetId: string; note: string },
): Promise<ProblemReport> {
  const [row] = await db.insert(problemReports).values(a).returning();
  return row!;
}

export async function listProblemReports(db: Db, ownerId: string): Promise<ProblemReport[]> {
  return db
    .select()
    .from(problemReports)
    .where(eq(problemReports.ownerId, ownerId))
    .orderBy(desc(problemReports.createdAt), desc(problemReports.id));
}
