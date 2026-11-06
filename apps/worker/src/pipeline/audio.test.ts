import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalStorage, createDb, createSession, getSession, updateSession, type Db, type Stage } from "@digestor/core/server";
import { releaseAudio, releaseReadyAudio } from "./audio.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("releaseAudio", () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  let storage: LocalStorage;

  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    root = await mkdtemp(path.join(os.tmpdir(), "digestor-audio-"));
    storage = new LocalStorage(root);
  });
  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  /** A session at `stage` with `audio.mp3` and `proxy.mp4` on disk and `audioKey` set. */
  async function session(stage: Stage, opts: { file?: boolean } = {}) {
    const row = await createSession(db, { title: `audio ${stage}`, source: "upload" });
    await mkdir(path.join(root, row.id), { recursive: true });
    if (opts.file !== false) await writeFile(path.join(root, row.id, "audio.mp3"), "a");
    await writeFile(path.join(root, row.id, "proxy.mp4"), "p");
    await updateSession(db, row.id, { stage, audioKey: `${row.id}/audio.mp3`, proxyKey: `${row.id}/proxy.mp4` });
    return row.id;
  }
  const audioOnDisk = (id: string) => existsSync(path.join(root, id, "audio.mp3"));
  const audioKey = async (id: string) => (await getSession(db, id))!.audioKey;

  it("deletes audio.mp3 of a ready session and clears its key; the preview stays", async () => {
    const id = await session("ready");
    expect(await releaseAudio({ db, storage }, id)).toBe(true);
    expect(audioOnDisk(id)).toBe(false);
    expect(await audioKey(id)).toBeNull();
    expect(existsSync(path.join(root, id, "proxy.mp4"))).toBe(true);
  });

  it("keeps the audio of a session that is not ready (a retry may transcribe again)", async () => {
    for (const stage of ["failed", "preparing_preview", "transcribing", "awaiting_context"] as const) {
      const id = await session(stage);
      expect(await releaseAudio({ db, storage }, id)).toBe(false);
      expect(audioOnDisk(id)).toBe(true);
      expect(await audioKey(id)).toBe(`${id}/audio.mp3`);
    }
  });

  it("is a no-op the second time", async () => {
    const id = await session("ready");
    await releaseAudio({ db, storage }, id);
    expect(await releaseAudio({ db, storage }, id)).toBe(false);
  });

  it("clears the key when the file is already gone", async () => {
    const id = await session("ready", { file: false });
    expect(await releaseAudio({ db, storage }, id)).toBe(true);
    expect(await audioKey(id)).toBeNull();
  });

  it("never throws: a failed delete is logged and the key is kept", async () => {
    const id = await session("ready");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { removeAudio: async () => { throw new Error("disk says no"); } };
    expect(await releaseAudio({ db, storage: broken }, id)).toBe(false);
    expect(await audioKey(id)).toBe(`${id}/audio.mp3`);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("an unknown session is a no-op", async () => {
    expect(await releaseAudio({ db, storage }, "00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("releaseReadyAudio releases every ready session that still has audio", async () => {
    await releaseReadyAudio({ db, storage }); // whatever earlier tests left behind
    const a = await session("ready");
    const b = await session("ready");
    const failed = await session("failed");
    expect(await releaseReadyAudio({ db, storage })).toEqual({ released: 2 });
    expect([audioOnDisk(a), audioOnDisk(b), audioOnDisk(failed)]).toEqual([false, false, true]);
  });
});
