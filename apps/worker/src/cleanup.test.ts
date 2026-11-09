import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalStorage, createDb, createSession, ensurePipelineRun, getPipelineRun, getSession, pipelineRuns, startAnalysisVersion, updateSession, type Db, type Stage } from "@digestor/core/server";
import type { ChromaClient } from "chromadb";
import { collectionName } from "./search/index.js";
import { runDailyCleanup, runVideoRetention, videoRetentionDays, type DailyCleanupDeps } from "./cleanup.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const DAY = 86_400_000;

describe("runDailyCleanup", () => {
  const deps = {} as DailyCleanupDeps; // the parts are fakes; nothing reads deps
  const quiet = () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  };

  it("runs the retention even when releasing the audio fails, then reports the failure", async () => {
    quiet();
    const runVideoRetention = vi.fn(async () => ({ removed: 2 }));
    const releaseReadyAudio = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(runDailyCleanup(deps, 14, { releaseReadyAudio, runVideoRetention })).rejects.toThrow(AggregateError);
    expect(runVideoRetention).toHaveBeenCalledWith(deps, 14);
    vi.restoreAllMocks();
  });

  it("releases the audio even when the retention fails", async () => {
    quiet();
    const releaseReadyAudio = vi.fn(async () => ({ released: 1 }));
    const runVideoRetention = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(runDailyCleanup(deps, 14, { releaseReadyAudio, runVideoRetention })).rejects.toThrow(AggregateError);
    expect(releaseReadyAudio).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("answers both counts when both parts succeed", async () => {
    quiet();
    const out = await runDailyCleanup(deps, 7, { releaseReadyAudio: async () => ({ released: 1 }), runVideoRetention: async () => ({ removed: 3 }) });
    expect(out).toEqual({ released: 1, removed: 3 });
    vi.restoreAllMocks();
  });
});

describe("videoRetentionDays", () => {
  it("reads VIDEO_RETENTION_DAYS and falls back to 14", () => {
    expect(videoRetentionDays({ VIDEO_RETENTION_DAYS: "30" })).toBe(30);
    expect(videoRetentionDays({})).toBe(14);
    expect(videoRetentionDays({ VIDEO_RETENTION_DAYS: "" })).toBe(14);
    expect(videoRetentionDays({ VIDEO_RETENTION_DAYS: "-1" })).toBe(14);
    expect(videoRetentionDays({ RETENTION_DAYS: "3" })).toBe(14); // the old variable is gone
  });
});

d("runVideoRetention", () => {
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

  const deps = () => ({ db, storage });

  /** A pipeline run row: it holds the journalist's context answers. */
  const runRow = async (sessionId: string) => void (await ensurePipelineRun(db, sessionId, "done"));
  const hasRunRow = async (sessionId: string) => (await getPipelineRun(db, sessionId)) !== null;

  /** A database whose deletes from `pipeline_runs` fail. */
  const failingRunDelete = (): Db =>
    new Proxy(db, {
      get(obj, prop, receiver) {
        if (prop === "delete") {
          return (t: Parameters<Db["delete"]>[0]) => {
            if (t === pipelineRuns) throw new Error("db down");
            return obj.delete(t);
          };
        }
        const v: unknown = Reflect.get(obj, prop, receiver);
        return typeof v === "function" ? v.bind(obj) : v;
      },
    });

  /** A session created `ageDays` ago in `stage`, with video files, a thumbnail and a render on disk. */
  async function seed(ageDays: number, stage: Stage) {
    const s = await createSession(db, { source: "upload", title: `age ${ageDays}` });
    await updateSession(db, s.id, { stage, createdAt: new Date(Date.now() - ageDays * DAY) });
    const files = ["original.mp4", "audio.mp3", "proxy.mp4", "thumbs/t.jpg", "clips/x.mp4"];
    for (const f of files) await writeFile(storage.resolve(storage.key(s.id, f)), "data");
    const at = (f: string) => existsSync(storage.resolve(storage.key(s.id, f)));
    return { id: s.id, at };
  }

  it("runVideoRetention keeps rows and renders", async () => {
    const old = await seed(15, "ready");
    const { removed } = await runVideoRetention(deps(), 14);
    expect(removed).toBe(1);
    expect(old.at("original.mp4")).toBe(false);
    expect(old.at("audio.mp3")).toBe(false);
    expect(old.at("proxy.mp4")).toBe(false);
    expect(old.at("clips/x.mp4")).toBe(true);
    expect(old.at("thumbs/t.jpg")).toBe(true);
    expect((await getSession(db, old.id))?.videoDeletedAt).toBeInstanceOf(Date);
  });

  it("retention deletes the pipeline_runs row", async () => {
    const old = await seed(15, "ready");
    await runRow(old.id);
    expect(await hasRunRow(old.id)).toBe(true);
    expect((await runVideoRetention(deps(), 14)).removed).toBe(1);
    expect(await hasRunRow(old.id)).toBe(false); // it holds the journalist's answers
  });

  it("deletes the session's search collection, and a Chroma failure does not block the retention", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const old = await seed(16, "ready");
      const deleted: string[] = [];
      const chroma = { deleteCollection: async ({ name }: { name: string }) => void deleted.push(name) } as unknown as ChromaClient;
      expect((await runVideoRetention({ ...deps(), chroma }, 14)).removed).toBe(1);
      expect(deleted).toEqual([collectionName(old.id)]);

      const other = await seed(17, "ready");
      const down = { deleteCollection: async () => Promise.reject(new Error("chroma down")) } as unknown as ChromaClient;
      expect((await runVideoRetention({ ...deps(), chroma: down }, 14)).removed).toBe(1);
      expect((await getSession(db, other.id))?.videoDeletedAt).toBeInstanceOf(Date);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("does not touch the same session twice", async () => {
    const old = await seed(20, "ready");
    expect((await runVideoRetention(deps(), 14)).removed).toBe(1);
    expect((await runVideoRetention(deps(), 14)).removed).toBe(0);
    expect(old.at("clips/x.mp4")).toBe(true);
  });

  it("leaves videoDeletedAt unset when the pipeline run row can't be deleted, so the next run retries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const old = await seed(21, "ready");
      await runRow(old.id);
      const deleted: string[] = [];
      const chroma = { deleteCollection: async ({ name }: { name: string }) => void deleted.push(name) } as unknown as ChromaClient;
      expect((await runVideoRetention({ db: failingRunDelete(), storage, chroma }, 14)).removed).toBe(0);
      expect(deleted).toEqual([]); // files, then the run row, then the index
      expect(old.at("original.mp4")).toBe(false);
      expect((await getSession(db, old.id))?.videoDeletedAt).toBeNull();
      expect(log).toHaveBeenCalled();
      expect((await runVideoRetention(deps(), 14)).removed).toBe(1);
      expect(await hasRunRow(old.id)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps recent sessions' videos and run rows", async () => {
    const recent = await seed(2, "ready");
    await runRow(recent.id);
    expect((await runVideoRetention(deps(), 14)).removed).toBe(0);
    expect(recent.at("original.mp4")).toBe(true);
    expect(await hasRunRow(recent.id)).toBe(true);
  });

  it("skips awaiting_context so the human pause can still be resumed", async () => {
    const waiting = await seed(30, "awaiting_context");
    await runRow(waiting.id);
    expect((await runVideoRetention(deps(), 14)).removed).toBe(0);
    expect(waiting.at("original.mp4")).toBe(true);
    expect(await hasRunRow(waiting.id)).toBe(true);
  });

  it("skips a session whose re-analysis is running", async () => {
    const busy = await seed(30, "ready");
    await startAnalysisVersion(db, busy.id, { profile: "general", reason: "reanalyze", models: {}, promptVersions: {} });
    expect((await runVideoRetention(deps(), 14)).removed).toBe(0);
    expect(busy.at("original.mp4")).toBe(true);
    expect((await getSession(db, busy.id))?.videoDeletedAt).toBeNull();
  });

  it("never touches a session that is still processing", async () => {
    const busy = await seed(30, "transcribing");
    await runRow(busy.id);
    expect((await runVideoRetention(deps(), 14)).removed).toBe(0);
    expect(busy.at("original.mp4")).toBe(true);
    expect(await hasRunRow(busy.id)).toBe(true);
  });
});
