import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { MomentWithHighlights } from "../analysisTypes.ts";
import { saveMoments, type NewMoment } from "./analysis.ts";
import type {
  AskActionKind, AskAction, AskMessage, AskMessageStatus, AskMessageWithActions, AskRole, Clip, ClipActor, ClipFormat,
  ClipEvent, FindMoreRequest, ProblemReport, ProblemTargetKind, RenderStatus, SelectionStatus, Track, TrackCue, TrackStatus,
} from "../personalTypes.ts";
import { GRANULARITY, type Granularity } from "../profiles.ts";
import type { Db } from "./client.ts";
import {
  askActions, askMessages, analysisVersions, clipEvents, clips, findMoreRequests, momentHighlights, moments, problemReports, selections, subtitleTracks,
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
  // Only "Find more" moments carry highlight types (the model's picks); Ask and user moments have none.
  const found = rows.filter((r) => r.origin === "find_more").map((r) => r.id);
  const tags = found.length ? await db.select().from(momentHighlights).where(inArray(momentHighlights.momentId, found)) : [];
  return rows.map((r) => ({ ...r, highlights: tags.filter((h) => h.momentId === r.id).map(({ type, method, value }) => ({ type, method, value })) }));
}

// ---------------------------------------------------------------- find more

const activeFindMore = ["pending", "running"] as const;

/**
 * Asks for a "Find more" run: creates the request, or resets a `done`/`failed` one to `pending` (its earlier moments stay
 * until the new run replaces them). null while one is `pending` or `running`: the caller must not send a second job.
 */
export async function requestFindMore(
  db: Db,
  a: { ownerId: string; analysisId: string; personId: string },
): Promise<FindMoreRequest | null> {
  const [row] = await db
    .insert(findMoreRequests)
    .values({ ...a, status: "pending" })
    .onConflictDoUpdate({
      target: [findMoreRequests.ownerId, findMoreRequests.analysisId, findMoreRequests.personId],
      set: { status: "pending", error: null, momentCount: 0, updatedAt: new Date() },
      setWhere: inArray(findMoreRequests.status, ["done", "failed"]),
    })
    .returning();
  return row ?? null;
}

/** pending → running; false when it isn't pending (already taken, or gone). */
export async function claimFindMore(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(findMoreRequests)
    .set({ status: "running" })
    .where(and(eq(findMoreRequests.id, id), eq(findMoreRequests.status, "pending")))
    .returning({ id: findMoreRequests.id });
  return rows.length > 0;
}

/**
 * Stores the run's moments as the owner's `find_more` moments and marks the request `done`, in one transaction. This
 * request's earlier moments go first, except those with a selection or a live clip; other people's and Ask's moments stay. Returns the
 * count, or 0 and stores nothing when the request isn't `running` any more.
 */
export async function finishFindMore(db: Db, id: string, rows: NewMoment[]): Promise<number> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [req] = await tx
      .update(findMoreRequests)
      .set({ status: "done", error: null, momentCount: rows.length })
      .where(and(eq(findMoreRequests.id, id), eq(findMoreRequests.status, "running")))
      .returning();
    if (!req) return 0;
    // Earlier moments go, except those the owner has a selection on (any status) or a live clip made from: their work is never deleted.
    await tx.delete(moments).where(and(eq(moments.findMoreRequestId, id), sql`not exists (select 1 from selections s where s.moment_id = ${moments.id})
      and not exists (select 1 from clips c where c.moment_id = ${moments.id} and c.deleted_at is null)`));
    await saveMoments(
      t,
      req.analysisId,
      rows.map((r) => ({ ...r, origin: "find_more" as const, ownerId: req.ownerId, findMoreRequestId: id, insideIdx: undefined })),
    );
    return rows.length;
  });
}

/** Marks a `pending` or `running` request failed with a user-facing message. */
export async function failFindMore(db: Db, id: string, message: string): Promise<void> {
  await db
    .update(findMoreRequests)
    .set({ status: "failed", error: message })
    .where(and(eq(findMoreRequests.id, id), inArray(findMoreRequests.status, [...activeFindMore])));
}

export async function getFindMore(db: Db, a: { ownerId: string; analysisId: string; personId: string }): Promise<FindMoreRequest | null> {
  const [row] = await db
    .select()
    .from(findMoreRequests)
    .where(and(eq(findMoreRequests.ownerId, a.ownerId), eq(findMoreRequests.analysisId, a.analysisId), eq(findMoreRequests.personId, a.personId)));
  return row ?? null;
}

/**
 * Ranges the owner already sees in an analysis version (official moments, their personal ones), for dropping a "Find
 * more" draft that repeats one. This request's own earlier moments count only when they are kept (a selection or a live clip).
 */
export async function listShownRanges(
  db: Db,
  a: { analysisId: string; ownerId: string; requestId: string },
): Promise<{ granularity: Granularity; startMs: number; endMs: number }[]> {
  const rows = await db
    .select({
      granularity: moments.granularity, startMs: moments.startMs, endMs: moments.endMs,
      requestId: moments.findMoreRequestId,
      selected: sql<boolean>`exists (select 1 from selections s where s.moment_id = ${moments.id})
        or exists (select 1 from clips c where c.moment_id = ${moments.id} and c.deleted_at is null)`,
    })
    .from(moments)
    .where(and(eq(moments.analysisId, a.analysisId), or(isNull(moments.ownerId), eq(moments.ownerId, a.ownerId))));
  return rows.filter((r) => r.requestId !== a.requestId || r.selected).map(({ granularity, startMs, endMs }) => ({ granularity, startMs, endMs }));
}

export async function getFindMoreById(db: Db, id: string): Promise<FindMoreRequest | null> {
  const [row] = await db.select().from(findMoreRequests).where(eq(findMoreRequests.id, id));
  return row ?? null;
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

/**
 * The owner's selections in a session, counted per analysis version. Selections are per moment, so after a re-analysis
 * the ones on an older version's moments no longer show; the Full briefing names them with this.
 */
export async function countSelectionsByAnalysis(
  db: Db,
  ownerId: string,
  sessionId: string,
): Promise<{ analysisId: string; version: number; count: number }[]> {
  return db
    .select({ analysisId: analysisVersions.id, version: analysisVersions.version, count: sql<number>`count(*)::int` })
    .from(selections)
    .innerJoin(moments, eq(moments.id, selections.momentId))
    .innerJoin(analysisVersions, eq(analysisVersions.id, moments.analysisId))
    .where(and(eq(selections.ownerId, ownerId), eq(analysisVersions.sessionId, sessionId)))
    .groupBy(analysisVersions.id, analysisVersions.version);
}

// ---------------------------------------------------------------- moment checks

/** A claim older than this is presumed lost (its job died) and may be taken again. */
const CHECK_CLAIM_MS = 10 * 60_000;

/**
 * Compare-and-set before sending `moment.check` (R29): true only for the caller that may send it — the moment has no
 * checks and no claim younger than 10 minutes. pg-boss's singletonKey doesn't dedupe on our standard queues.
 */
export async function claimMomentCheck(db: Db, momentId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(moments)
    .set({ checksRequestedAt: now })
    .where(
      and(
        eq(moments.id, momentId),
        isNull(moments.checks),
        or(isNull(moments.checksRequestedAt), lt(moments.checksRequestedAt, new Date(now.getTime() - CHECK_CLAIM_MS))),
      ),
    )
    .returning({ id: moments.id });
  return rows.length > 0;
}

/** Drops a claim whose job couldn't be sent or gave up, so the next request (e.g. "Check again") can claim it. */
export async function releaseMomentCheck(db: Db, momentId: string): Promise<void> {
  await db.update(moments).set({ checksRequestedAt: null }).where(and(eq(moments.id, momentId), isNull(moments.checks)));
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

/**
 * Cues are clip-relative, so a bounds change outdates every `ready` track built for other bounds and clears its
 * approval (R27). An `outdated` track whose built range matches again (an undo) comes back as `ready`, unapproved.
 */
async function outdateTracks(tx: Tx, clipId: string, bounds: { startMs: number; endMs: number }): Promise<void> {
  const same = and(eq(subtitleTracks.builtStartMs, bounds.startMs), eq(subtitleTracks.builtEndMs, bounds.endMs));
  await tx
    .update(subtitleTracks)
    .set({ status: "outdated", approvedAt: null })
    .where(and(eq(subtitleTracks.clipId, clipId), eq(subtitleTracks.status, "ready"), sql`not coalesce(${same}, false)`));
  await tx
    .update(subtitleTracks)
    .set({ status: "ready", approvedAt: null })
    .where(and(eq(subtitleTracks.clipId, clipId), eq(subtitleTracks.status, "outdated"), same));
}

/**
 * Everything a bounds change invalidates, in the caller's transaction: the render and burns (stale), the tracks
 * (outdated, R27) and the warnings acknowledgement (R28: checks were made for the original cut).
 */
async function afterBoundsChange(tx: Tx, clipId: string, bounds: { startMs: number; endMs: number }): Promise<void> {
  await tx.update(clips).set({ warningsAck: false }).where(eq(clips.id, clipId));
  await outdateTracks(tx, clipId, bounds);
}

type NewClip = { sessionId: string; ownerId: string; momentId?: string | null; startMs: number; endMs: number; actor: ClipActor };

async function insertClip(tx: Tx, a: NewClip): Promise<Clip> {
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
}

export async function createClip(db: Db, a: NewClip): Promise<Clip> {
  return db.transaction((tx) => insertClip(tx, a));
}

/**
 * "Confirm selection": one live clip per moment (bounds = the moment's). Serialised per session by an advisory
 * lock, so parallel confirms insert each missing clip once. Returns the clips of the given moments.
 */
export async function confirmClips(
  db: Db,
  ownerId: string,
  sessionId: string,
  wanted: { id: string; startMs: number; endMs: number }[],
): Promise<Clip[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
    const live = await tx
      .select()
      .from(clips)
      .where(and(eq(clips.ownerId, ownerId), eq(clips.sessionId, sessionId), alive));
    const byMoment = new Map(live.flatMap((c) => (c.momentId ? [[c.momentId, c] as const] : [])));
    const out: Clip[] = [];
    for (const m of wanted) {
      let clip = byMoment.get(m.id);
      if (!clip) {
        clip = await insertClip(tx, { sessionId, ownerId, momentId: m.id, startMs: m.startMs, endMs: m.endMs, actor: "user" });
        byMoment.set(m.id, clip);
      }
      out.push(clip);
    }
    return out;
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

/** Like `getClip` but also returns a soft-deleted clip (undo needs to find it). */
export async function getClipAny(db: Db, id: string): Promise<Clip | null> {
  const [row] = await db.select().from(clips).where(eq(clips.id, id));
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
    if (boundsChanged) await afterBoundsChange(tx, id, row!);
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
    if (ev.kind === "bounds") await afterBoundsChange(tx, clipId, ev.before as { startMs: number; endMs: number });
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

/** Marks a render failed only while it is still queued or rendering (never overwrites done/stale). */
export async function failClipRender(db: Db, id: string): Promise<void> {
  await db
    .update(clips)
    .set({ renderStatus: "failed", updatedAt: new Date() })
    .where(and(eq(clips.id, id), alive, inArray(clips.renderStatus, ["queued", "rendering"])));
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

/** Removes a track that never got going (its prepare job couldn't be queued); only while `preparing`. */
export async function deleteTrack(db: Db, id: string): Promise<void> {
  await db.delete(subtitleTracks).where(and(eq(subtitleTracks.id, id), eq(subtitleTracks.status, "preparing")));
}

/**
 * Removes a failed or outdated track so the language can be built again ("Try again", "Rebuild"). Neither status can
 * be approved, so this never races an approval or a burn claim; a burn still being made keeps the row. True when a
 * row was deleted.
 */
export async function deleteFailedTrack(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(subtitleTracks)
    .where(
      and(
        eq(subtitleTracks.id, id),
        inArray(subtitleTracks.status, ["failed", "outdated"]),
        sql`${subtitleTracks.burnStatus} not in ('queued', 'rendering')`,
      ),
    )
    .returning({ id: subtitleTracks.id });
  return rows.length > 0;
}

/**
 * Records whether the user wants a burned-in version of this track. A request is a `burnStatus` other than `none`:
 * `stale` means "requested, not built (or out of date)". Asking turns `none` into `stale`; dropping the request
 * turns stale, failed or done into `none`. A burn that is queued or rendering is never touched (the caller checks
 * the returned status). Returns the track, or null when it doesn't exist.
 */
export async function requestTrackBurn(db: Db, id: string, want: boolean): Promise<Track | null> {
  await db
    .update(subtitleTracks)
    .set({ burnStatus: want ? "stale" : "none" })
    .where(and(eq(subtitleTracks.id, id), inArray(subtitleTracks.burnStatus, want ? ["none"] : ["stale", "failed", "done"])));
  return getTrack(db, id);
}

async function lockTrack(tx: Tx, id: string): Promise<Track> {
  const [row] = await tx.select().from(subtitleTracks).where(eq(subtitleTracks.id, id)).for("update");
  if (!row) throw new Error(`Track not found: ${id}`);
  return row;
}

/**
 * Stores a track's cues. `built` is the clip range they were made for: when the clip's bounds no longer match it (a
 * trim landed while the track was preparing), the track is stored `outdated` instead of `status`. The clip row is
 * locked first (the order updateClip uses: clip, then track), so a trim still in its transaction is waited for.
 */
export async function setTrackCues(
  db: Db,
  id: string,
  cues: TrackCue[],
  status: TrackStatus,
  built?: { startMs: number; endMs: number },
): Promise<Track> {
  return db.transaction(async (tx) => {
    let next = status;
    if (built) {
      const [peek] = await tx.select({ clipId: subtitleTracks.clipId }).from(subtitleTracks).where(eq(subtitleTracks.id, id));
      if (!peek) throw new Error(`Track not found: ${id}`);
      const clip = await lockClip(tx, peek.clipId);
      if (!clip || clip.startMs !== built.startMs || clip.endMs !== built.endMs) next = "outdated";
    }
    const [row] = await tx
      .update(subtitleTracks)
      .set({
        cues,
        status: next,
        ...(built ? { builtStartMs: built.startMs, builtEndMs: built.endMs } : {}),
        error: null,
        approvedAt: null,
        burnStatus: sql`CASE WHEN ${subtitleTracks.burnStatus} = 'done' THEN 'stale' ELSE ${subtitleTracks.burnStatus} END`,
      })
      .where(eq(subtitleTracks.id, id))
      .returning();
    if (!row) throw new Error(`Track not found: ${id}`);
    return row;
  });
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

/** Approves a `ready` track whose lines are all filled; an outdated (or not yet built) one is `not_ready`. */
export async function approveTrack(db: Db, id: string): Promise<"ok" | "missing_cues" | "not_ready"> {
  return db.transaction(async (tx) => {
    const track = await lockTrack(tx, id);
    if (track.status !== "ready") return "not_ready";
    if (track.cues.length === 0 || track.cues.some((c) => c.missing || c.text.trim() === "")) return "missing_cues";
    await tx.update(subtitleTracks).set({ approvedAt: new Date() }).where(eq(subtitleTracks.id, id));
    return "ok";
  });
}

/** Burned-in versions exist only for approved tracks that are current (`ready`, not outdated). */
export async function claimTrackBurn(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(subtitleTracks)
    .set({ burnStatus: "queued" })
    .where(
      and(
        eq(subtitleTracks.id, id),
        eq(subtitleTracks.status, "ready"),
        sql`${subtitleTracks.approvedAt} is not null`,
        sql`exists (select 1 from ${clips} where ${clips.id} = ${subtitleTracks.clipId} and ${clips.deletedAt} is null)`,
        inArray(subtitleTracks.burnStatus, ["none", "failed", "stale"]),
      ),
    )
    .returning({ id: subtitleTracks.id });
  return rows.length > 0;
}

export async function failTrackBurn(db: Db, id: string): Promise<void> {
  await db
    .update(subtitleTracks)
    .set({ burnStatus: "failed" })
    .where(and(eq(subtitleTracks.id, id), inArray(subtitleTracks.burnStatus, ["queued", "rendering"])));
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
  a: { text: string; toolCalls?: unknown; status: Exclude<AskMessageStatus, "pending" | "running"> },
): Promise<AskMessage> {
  const [row] = await db
    .update(askMessages)
    .set({ text: a.text, toolCalls: a.toolCalls ?? null, status: a.status })
    .where(eq(askMessages.id, id))
    .returning();
  if (!row) throw new Error(`Ask message not found: ${id}`);
  return row;
}

/**
 * Compare-and-set `pending` → `running` before a worker answers (T14): true only for the caller that claimed it. A
 * retry that finds the message already `running` knows an earlier attempt died partway.
 */
export async function claimAskMessage(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(askMessages)
    .set({ status: "running" })
    .where(and(eq(askMessages.id, id), eq(askMessages.status, "pending")))
    .returning({ id: askMessages.id });
  return rows.length > 0;
}

/** `running` → `pending`: the run failed before changing anything, so pg-boss's retry may answer it again. */
export async function releaseAskMessage(db: Db, id: string): Promise<void> {
  await db
    .update(askMessages)
    .set({ status: "pending" })
    .where(and(eq(askMessages.id, id), eq(askMessages.status, "running")));
}

export async function getAskMessage(db: Db, id: string): Promise<AskMessage | null> {
  const [row] = await db.select().from(askMessages).where(eq(askMessages.id, id));
  return row ?? null;
}

/** Removes ask messages (their actions cascade); used to roll back a question whose job could not be queued. */
export async function deleteAskMessages(db: Db, ids: string[]): Promise<void> {
  if (ids.length > 0) await db.delete(askMessages).where(inArray(askMessages.id, ids));
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

export async function getAskAction(db: Db, id: string): Promise<AskAction | null> {
  const [row] = await db.select().from(askActions).where(eq(askActions.id, id));
  return row ?? null;
}

/**
 * Confirms a `bulk_selection` action: resolves it (compare-and-set from `pending`) and applies the status to every
 * moment in ONE transaction. Returns false, changing nothing, when the action is no longer pending.
 * `status` null means back to proposed.
 */
export async function confirmBulkSelection(
  db: Db,
  ownerId: string,
  actionId: string,
  momentIds: string[],
  status: SelectionStatus | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const resolved = await tx
      .update(askActions)
      .set({ status: "confirmed" })
      .where(and(eq(askActions.id, actionId), eq(askActions.status, "pending")))
      .returning({ id: askActions.id });
    if (resolved.length === 0) return false;
    for (const momentId of momentIds) {
      if (status === null) {
        await tx.delete(selections).where(and(eq(selections.ownerId, ownerId), eq(selections.momentId, momentId)));
      } else {
        await tx
          .insert(selections)
          .values({ ownerId, momentId, status })
          .onConflictDoUpdate({ target: [selections.ownerId, selections.momentId], set: { status, updatedAt: new Date() } });
      }
    }
    return true;
  });
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
