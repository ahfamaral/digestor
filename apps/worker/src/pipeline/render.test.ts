import os from "node:os";
import path from "node:path";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LocalStorage, approveTrack, createClip, createDb, createSession, createTrack, getClip, getTrack, setTrackCues, updateClip,
  updateSession, claimClipRender, claimTrackBurn, type Db,
} from "@digestor/core/server";
import { handleBurnTrack, handleRenderClip } from "../jobs.js";
import { VideoRemovedError } from "../errors.js";
import { burnTrack, renderClipJob, type RenderDeps } from "./render.js";

const TEST_MP4 = fileURLToPath(new URL("../../test/tmp/test.mp4", import.meta.url));
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("clip render jobs", () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  let storage: LocalStorage;
  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    root = await mkdtemp(path.join(os.tmpdir(), "digestor-render-"));
    storage = new LocalStorage(root);
  });
  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const s = await createSession(db, { title: "T", source: "upload" });
    const originalKey = storage.key(s.id, "original.mp4");
    copyFileSync(TEST_MP4, storage.resolve(originalKey));
    await updateSession(db, s.id, { hasVideo: true, originalKey });
    const clip = await createClip(db, { sessionId: s.id, ownerId: "owner", startMs: 1000, endMs: 3000, actor: "user" });
    return { s, clip };
  }
  const fake = (fn: (o: { output: string; assPath?: string }) => Promise<void> | void) =>
    vi.fn(async (o: { output: string; assPath?: string }) => void (await fn(o)));

  it("cuts a plain clip to clips/<id>.mp4 and marks it done", async () => {
    const { s, clip } = await seed();
    await claimClipRender(db, clip.id);
    await renderClipJob({ db, storage }, clip.id);
    const after = (await getClip(db, clip.id))!;
    expect(after.renderStatus).toBe("done");
    expect(after.renderKey).toBe(`${s.id}/clips/${clip.id}.mp4`);
    expect(existsSync(storage.resolve(after.renderKey!))).toBe(true);
  });

  it("render refuses after video removal", async () => {
    const { s, clip } = await seed();
    await updateSession(db, s.id, { videoDeletedAt: new Date() });
    await expect(renderClipJob({ db, storage }, clip.id)).rejects.toBeInstanceOf(VideoRemovedError);
  });

  it("edit during render marks stale", async () => {
    const { clip } = await seed();
    await claimClipRender(db, clip.id);
    const renderClip = fake(async () => {
      await updateClip(db, clip.id, { endMs: 3500 }, "user");
    });
    const deps: RenderDeps = { db, storage, renderClip };
    await renderClipJob(deps, clip.id);
    expect((await getClip(db, clip.id))!.renderStatus).toBe("stale");
  });

  async function seedTrack() {
    const { s, clip } = await seed();
    const track = (await createTrack(db, clip.id, "pt"))!;
    await setTrackCues(db, track.id, [{ startMs: 0, endMs: 1500, original: "Hello world", text: "Olá mundo", missing: false }], "ready");
    await approveTrack(db, track.id);
    return { s, clip, track };
  }

  it("burnTrack uses translated text", async () => {
    const { s, clip, track } = await seedTrack();
    let ass = "";
    const renderClip = fake((o) => {
      ass = readFileSync(o.assPath!, "utf8");
    });
    await claimTrackBurn(db, track.id);
    await burnTrack({ db, storage, renderClip }, track.id);
    expect(ass).toContain("Olá mundo");
    expect(ass).not.toContain("Hello world");
    const t = (await getTrack(db, track.id))!;
    expect(t.burnStatus).toBe("done");
    expect(t.burnKey).toBe(`${s.id}/clips/${clip.id}.pt.burned.mp4`);
  });

  it("burn with a real render produces the file; edited cues during the burn mark it stale", async () => {
    const { track } = await seedTrack();
    await claimTrackBurn(db, track.id);
    await burnTrack({ db, storage }, track.id);
    const t = (await getTrack(db, track.id))!;
    expect(t.burnStatus).toBe("done");
    expect(existsSync(storage.resolve(t.burnKey!))).toBe(true);

    const again = await seedTrack();
    await claimTrackBurn(db, again.track.id);
    const renderClip = fake(async () => {
      await updateClip(db, again.clip.id, { credit: "Someone" }, "user");
    });
    await burnTrack({ db, storage, renderClip }, again.track.id);
    expect((await getTrack(db, again.track.id))!.burnStatus).toBe("stale");
  });

  describe("handlers", () => {
    it("VideoRemovedError marks failed and completes; other errors fail only on the final attempt", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { s, clip } = await seed();
      await updateSession(db, s.id, { videoDeletedAt: new Date() });
      await claimClipRender(db, clip.id);
      await handleRenderClip({ db, storage }, { clipId: clip.id }, { retryCount: 0, retryLimit: 2 });
      expect((await getClip(db, clip.id))!.renderStatus).toBe("failed");

      const b = await seed();
      await claimClipRender(db, b.clip.id);
      const boom = fake(() => {
        throw new Error("ffmpeg died");
      });
      await expect(handleRenderClip({ db, storage, renderClip: boom }, { clipId: b.clip.id }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow();
      expect((await getClip(db, b.clip.id))!.renderStatus).not.toBe("failed");
      await expect(handleRenderClip({ db, storage, renderClip: boom }, { clipId: b.clip.id }, { retryCount: 2, retryLimit: 2 })).rejects.toThrow();
      expect((await getClip(db, b.clip.id))!.renderStatus).toBe("failed");

      const t = await seedTrack();
      await updateSession(db, t.s.id, { videoDeletedAt: new Date() });
      await claimTrackBurn(db, t.track.id);
      await handleBurnTrack({ db, storage }, { trackId: t.track.id }, { retryCount: 0, retryLimit: 2 });
      expect((await getTrack(db, t.track.id))!.burnStatus).toBe("failed");
      spy.mockRestore();
    });
  });
});
