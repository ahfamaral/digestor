import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorage, createDb, createSession, getSession, updateSession, type Db, type Stage } from "@digestor/core/server";
import { retentionDays, runCleanup } from "./cleanup.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const DAY = 86_400_000;

describe("retentionDays", () => {
  it("reads RETENTION_DAYS and falls back to 7", () => {
    expect(retentionDays({ RETENTION_DAYS: "14" })).toBe(14);
    expect(retentionDays({})).toBe(7);
    expect(retentionDays({ RETENTION_DAYS: "" })).toBe(7);
    expect(retentionDays({ RETENTION_DAYS: "-1" })).toBe(7);
  });
});

d("runCleanup", () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  let storage: LocalStorage;

  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    root = await mkdtemp(path.join(os.tmpdir(), "digestor-cleanup-"));
    storage = new LocalStorage(root);
  });
  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  /** A session created `ageDays` ago in `stage`, with an original file on disk. */
  async function seed(ageDays: number, stage: Stage): Promise<{ id: string; folder: string }> {
    const s = await createSession(db, { source: "upload", title: `age ${ageDays}` });
    await updateSession(db, s.id, { stage, createdAt: new Date(Date.now() - ageDays * DAY) });
    const file = storage.resolve(storage.key(s.id, "original.mp4"));
    await writeFile(file, "video");
    return { id: s.id, folder: path.dirname(file) };
  }

  it("deletes sessions older than the retention window with their files", async () => {
    const old = await seed(8, "done");
    const { deleted } = await runCleanup({ db, storage }, 7);
    expect(deleted).toBe(1);
    expect(await getSession(db, old.id)).toBeNull();
    expect(existsSync(old.folder)).toBe(false);
  });

  it("keeps recent sessions", async () => {
    const recent = await seed(2, "done");
    const { deleted } = await runCleanup({ db, storage }, 7);
    expect(deleted).toBe(0);
    expect(await getSession(db, recent.id)).not.toBeNull();
    expect(existsSync(recent.folder)).toBe(true);
  });

  it("never deletes a session that is still processing", async () => {
    const busy = await seed(30, "transcribing");
    const { deleted } = await runCleanup({ db, storage }, 7);
    expect(deleted).toBe(0);
    expect((await getSession(db, busy.id))?.stage).toBe("transcribing");
    expect(existsSync(busy.folder)).toBe(true);
  });
});
