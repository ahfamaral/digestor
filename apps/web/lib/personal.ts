import { JOB_OPTIONS, OWNER_ID, QUEUES, VIDEO_REMOVED, cutsMidSentence, findBoundaries, type Range } from "@digestor/core";
import {
  claimMomentCheck, getAnalysisVersion, getClip, getClipAny, getMoment, getSession, getTranscript, releaseMomentCheck, type Clip, type Db,
  type Session,
} from "@digestor/core/server";
import { errorResponse } from "./http";
import type { JobSender } from "./server";

export const NOT_READY = "This video isn't ready yet.";
export { VIDEO_REMOVED };
export const QUEUE_FAILED = "Couldn't queue the job. Please try again.";

/** The session when it exists and is `ready`; otherwise the error response to return (404 / 409). */
export async function readySession(db: Db, sessionId: string): Promise<{ session: Session } | { error: Response }> {
  const session = await getSession(db, sessionId);
  if (!session) return { error: errorResponse(404, "Session not found.") };
  if (session.stage !== "ready") return { error: errorResponse(409, NOT_READY) };
  return { session };
}

/**
 * The caller's clip and its session when the clip exists (live, or deleted too with `includeDeleted`), belongs to
 * the owner, and the session is `ready`; otherwise the error response (404 / 409).
 */
export async function readyClip(
  db: Db,
  clipId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<{ clip: Clip; session: Session } | { error: Response }> {
  const clip = await (opts.includeDeleted ? getClipAny(db, clipId) : getClip(db, clipId));
  if (!clip || clip.ownerId !== OWNER_ID) return { error: errorResponse(404, "Clip not found.") };
  const ready = await readySession(db, clip.sessionId);
  if ("error" in ready) return ready.error.status === 404 ? { error: errorResponse(404, "Clip not found.") } : ready;
  return { clip, session: ready.session };
}

/** The moment's session id, or null when the moment (or its analysis) doesn't exist. */
export async function sessionIdOfMoment(db: Db, momentId: string): Promise<string | null> {
  const moment = await getMoment(db, momentId);
  if (!moment) return null;
  return (await getAnalysisVersion(db, moment.analysisId))?.sessionId ?? null;
}

/**
 * Asks the worker to run the clip checks for a moment. The send is claimed in the database first (R29), so parallel
 * or repeated requests queue one job; false when there was nothing to send (checks exist, or a claim is waiting). A
 * failed send frees the claim and rethrows.
 */
export async function sendMomentCheck(db: Db, boss: JobSender, momentId: string): Promise<boolean> {
  if (!(await claimMomentCheck(db, momentId))) return false;
  try {
    await boss.send(QUEUES.checkMoment, { momentId }, JOB_OPTIONS);
  } catch (err) {
    await releaseMomentCheck(db, momentId).catch((e: unknown) => console.error("moment check: release failed", e));
    throw err;
  }
  return true;
}

/** Checks are lazy and best-effort: a failed enqueue is logged, never shown (export and Prepare ask again). */
export async function sendMomentCheckQuietly(db: Db, boss: JobSender, momentId: string): Promise<void> {
  try {
    await sendMomentCheck(db, boss, momentId);
  } catch (err) {
    console.error("moment check: enqueue failed", err);
  }
}

/** R30: once the video is removed, a kept clip and its subtitles are frozen (their rendered files still download). */
export function frozenError(session: Session): Response | null {
  return session.videoDeletedAt ? errorResponse(409, VIDEO_REMOVED) : null;
}

/** True when the cut starts or ends inside a sentence (an Alt cut); false when there is no transcript to tell. */
export async function midSentenceFor(db: Db, session: Pick<Session, "id" | "durationMs">, range: Range): Promise<boolean> {
  const transcript = await getTranscript(db, session.id);
  if (!transcript) return false;
  const boundaries = findBoundaries(transcript.words, session.durationMs ?? transcript.durationMs);
  return boundaries.length >= 2 && cutsMidSentence(boundaries, range);
}
