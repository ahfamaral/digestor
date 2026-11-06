import { access } from "node:fs/promises";
import { claimProxy, failProxy, finishProxy, getSession, settlePreview, type Db, type LocalStorage } from "@digestor/core/server";
import type * as ffmpeg from "../media/ffmpeg.js";
import { releaseAudio } from "./audio.js";

export type ProxyDeps = { db: Db; storage: LocalStorage; media: Pick<typeof ffmpeg, "makeProxy"> };

/**
 * Encodes the session's 360p preview copy in its own job, so the pipeline never waits for it. The row goes
 * `pending` → `running` → `done` (with `proxyKey` in the same update); then `settlePreview` closes the join when the
 * analysis already ended, and a now `ready` session loses its `audio.mp3`. No claim means another job has it (or it is done): nothing to do. With `retrying` a
 * `running` row is taken over (the crashed or failed earlier attempt left it so). A video that is gone is
 * deterministic: the row is failed (and the join run) without an error. An ffmpeg error is rethrown for the caller.
 */
export async function runProxy(deps: ProxyDeps, sessionId: string, opts: { retrying?: boolean } = {}): Promise<void> {
  const { db, storage, media } = deps;
  if (!(await claimProxy(db, sessionId, { takeover: opts.retrying }))) return;
  const session = await getSession(db, sessionId);
  const original = session?.originalKey && !session.videoDeletedAt ? storage.resolve(session.originalKey) : null;
  if (!session || !original || !(await access(original).then(() => true, () => false))) {
    console.error(`[proxy] session ${sessionId}: the original video is gone; no preview copy can be made`);
    await failProxy(db, sessionId);
    await settlePreview(db, sessionId);
    return;
  }
  const proxyKey = storage.key(sessionId, "proxy.mp4");
  await media.makeProxy(original, storage.resolve(proxyKey), { hasVideo: session.hasVideo });
  if (!(await finishProxy(db, sessionId, proxyKey))) return;
  await settlePreview(db, sessionId);
  await releaseAudio({ db, storage }, sessionId); // only once the join made it ready
}
