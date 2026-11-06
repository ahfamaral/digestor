import { getSession, listSessionsWithAudioToRelease, updateSession, type Db, type LocalStorage } from "@digestor/core/server";

export type AudioDeps = { db: Db; storage: Pick<LocalStorage, "removeAudio"> };

/**
 * Deletes `audio.mp3` of a `ready` session and clears `audioKey`. Only transcription reads the file, and once the session
 * is ready the voice samples play from the preview copy. A session in any other stage keeps it (a retry may transcribe
 * again). Best effort: never throws; a failed delete keeps the key, so the daily clean-up tries again. True when released.
 */
export async function releaseAudio(deps: AudioDeps, sessionId: string): Promise<boolean> {
  try {
    const session = await getSession(deps.db, sessionId);
    if (!session || session.stage !== "ready" || !session.audioKey) return false;
    await deps.storage.removeAudio(sessionId);
    await updateSession(deps.db, sessionId, { audioKey: null });
    return true;
  } catch (err) {
    console.error(`[audio] could not release audio.mp3 of ${sessionId}:`, err);
    return false;
  }
}

/** `releaseAudio` for every `ready` session that still has audio (the daily clean-up; also covers sessions from before). */
export async function releaseReadyAudio(deps: AudioDeps): Promise<{ released: number }> {
  let released = 0;
  for (const session of await listSessionsWithAudioToRelease(deps.db)) if (await releaseAudio(deps, session.id)) released++;
  return { released };
}
