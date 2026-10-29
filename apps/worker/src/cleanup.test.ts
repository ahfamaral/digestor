import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
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
  let saver: PostgresSaver;

  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    root = await mkdtemp(path.join(os.tmpdir(), "digestor-cleanup-"));
    storage = new LocalStorage(root);
    saver = PostgresSaver.fromConnString(url!);
    await saver.setup();
  });
  afterAll(async () => {
    await saver.end();
    await close();
    await rm(root, { recursive: true, force: true });
  });

  const deps = () => ({ db, storage, checkpointer: saver });

  /** Writes a real LangGraph checkpoint for thread `sessionId`, as the pipeline does. */
  async function checkpoint(sessionId: string): Promise<void> {
    const State = Annotation.Root({ answer: Annotation<string> });
    const graph = new StateGraph(State)
      .addNode("ask", async () => ({ answer: "the minister's name" }))
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: saver });
    await graph.invoke({ answer: "" }, { configurable: { thread_id: sessionId } });
  }
  const hasCheckpoint = async (sessionId: string) =>
    (await saver.getTuple({ configurable: { thread_id: sessionId } })) !== undefined;

  /** A session created `ageDays` ago in `stage`, with an original file on disk. */
  async function seed(ageDays: number, stage: Stage): Promise<{ id: string; folder: string }> {
    const s = await createSession(db, { source: "upload", title: `age ${ageDays}` });
    await updateSession(db, s.id, { stage, createdAt: new Date(Date.now() - ageDays * DAY) });
    const file = storage.resolve(storage.key(s.id, "original.mp4"));
    await writeFile(file, "video");
    return { id: s.id, folder: path.dirname(file) };
  }

  it("deletes sessions older than the retention window with their files and checkpoints", async () => {
    const old = await seed(8, "done");
    await checkpoint(old.id);
    expect(await hasCheckpoint(old.id)).toBe(true);
    const { deleted } = await runCleanup(deps(), 7);
    expect(deleted).toBe(1);
    expect(await getSession(db, old.id)).toBeNull();
    expect(existsSync(old.folder)).toBe(false);
    expect(await hasCheckpoint(old.id)).toBe(false);
  });

  it("keeps the row when the checkpoints can't be deleted, so the next run retries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const old = await seed(9, "done");
      const failing = { deleteThread: async () => Promise.reject(new Error("db down")) };
      const { deleted } = await runCleanup({ db, storage, checkpointer: failing }, 7);
      expect(deleted).toBe(0);
      expect(await getSession(db, old.id)).not.toBeNull();
      expect(log).toHaveBeenCalled();
      expect((await runCleanup(deps(), 7)).deleted).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps recent sessions and their checkpoints", async () => {
    const recent = await seed(2, "done");
    await checkpoint(recent.id);
    const { deleted } = await runCleanup(deps(), 7);
    expect(deleted).toBe(0);
    expect(await getSession(db, recent.id)).not.toBeNull();
    expect(existsSync(recent.folder)).toBe(true);
    expect(await hasCheckpoint(recent.id)).toBe(true);
  });

  it("never deletes a session that is still processing", async () => {
    const busy = await seed(30, "transcribing");
    await checkpoint(busy.id);
    const { deleted } = await runCleanup(deps(), 7);
    expect(deleted).toBe(0);
    expect((await getSession(db, busy.id))?.stage).toBe("transcribing");
    expect(existsSync(busy.folder)).toBe(true);
    expect(await hasCheckpoint(busy.id)).toBe(true);
  });
});
