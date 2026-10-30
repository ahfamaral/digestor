import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { createDb, createSession, getSession, setStage, type Db } from "@digestor/core/server";
import { TranscriptionError } from "./transcribe/assemblyai.js";
import { MissingApiKeyError, failureMessage, handleResume, notImplemented, processJobs, handleStart, type JobContext } from "./jobs.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function stubGraph(opts: { next?: string[]; fail?: Error; interrupted?: boolean; checkpoint?: boolean } = {}) {
  const invoke = vi.fn(async (..._a: unknown[]) => {
    if (opts.fail) throw opts.fail;
    return {};
  });
  const getState = vi.fn(async (..._a: unknown[]) => ({
    next: opts.next ?? [],
    tasks: opts.interrupted ? [{ interrupts: [{ value: 1 }] }] : [{ interrupts: [] }],
    // LangGraph only sets createdAt when the thread has a checkpoint.
    ...(opts.checkpoint ? { createdAt: "2026-10-30T12:00:00.000Z" } : {}),
  }));
  return { invoke, getState };
}

/** Attempt metadata as pg-boss passes it (includeMetadata): retryCount 0 is the first try. */
const FIRST = { retryCount: 0, retryLimit: 2 };
const LAST = { retryCount: 2, retryLimit: 2 };

describe("payloads", () => {
  it("invalid payload is logged and completed, valid ones are handled with their attempt", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    const schema = { safeParse: (d: unknown) => (d === "ok" ? { success: true as const, data: d } : { success: false as const, error: { message: "bad" } }) };
    await processJobs("q", schema, handle, [{ data: "nope", ...FIRST }, { data: "ok", retryCount: 1, retryLimit: 2 }]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith("ok", { retryCount: 1, retryLimit: 2 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("failureMessage", () => {
  it("maps known errors", () => {
    expect(failureMessage(new TranscriptionError("bad audio"))).toBe("Transcription failed: bad audio");
    expect(failureMessage(new MissingApiKeyError("ANTHROPIC_API_KEY"))).toBe("ANTHROPIC_API_KEY is not set on the server.");
  });
  it("hides unknown errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(failureMessage(new Error("ECONNRESET secret"))).toBe(
      "Something went wrong while processing this video. Please try again.",
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

d("job handlers", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(() => {
    ({ db, close } = createDb(url!));
  });
  afterAll(() => close());
  const ctxFor = (graph: ReturnType<typeof stubGraph>): JobContext => ({ db, graph: graph as unknown as JobContext["graph"], deps: {} as JobContext["deps"] });
  const newSession = async () => (await createSession(db, { source: "upload", title: "t" })).id;

  it("handleStart starts a fresh run with thread_id = sessionId", async () => {
    const g = stubGraph();
    const id = await newSession();
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    const cfg = { configurable: { thread_id: id } };
    expect(g.invoke).toHaveBeenCalledWith({ sessionId: id }, cfg);
  });

  it("handleStart resumes from an existing checkpoint", async () => {
    const g = stubGraph({ next: ["transcribe"] });
    const id = await newSession();
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    expect(g.invoke).toHaveBeenCalledWith(null, { configurable: { thread_id: id } });
  });

  it("handleStart on a finished thread (checkpoint, nothing pending) is a logged no-op", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const g = stubGraph({ checkpoint: true });
    const id = await newSession();
    await setStage(db, id, "failed", 20, "No speech was detected in this video.");
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    expect(g.invoke).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already finished"));
    log.mockRestore();
  });

  it("handleStart on a ready session is a no-op even without a checkpoint", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const g = stubGraph();
    const id = await newSession();
    await setStage(db, id, "ready", 100);
    await handleStart(ctxFor(g), { sessionId: id }, FIRST);
    expect(g.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("handleResume passes a Command with the payload", async () => {
    const g = stubGraph({ next: ["context"], interrupted: true });
    const id = await newSession();
    const payload = { action: "continue", answers: [] } as never;
    await handleResume(ctxFor(g), { sessionId: id, payload }, FIRST);
    const [arg, cfg] = g.invoke.mock.calls[0]!;
    expect(arg).toBeInstanceOf(Command);
    expect((arg as Command).resume).toEqual(payload);
    expect(cfg).toEqual({ configurable: { thread_id: id } });
  });

  it("handleResume continues a mid-run thread with null (stale resume is not replayed)", async () => {
    const g = stubGraph({ next: ["finish"] });
    const id = await newSession();
    await handleResume(ctxFor(g), { sessionId: id, payload: { action: "continue", answers: [] } as never }, FIRST);
    expect(g.invoke).toHaveBeenCalledWith(null, { configurable: { thread_id: id } });
  });

  it("handleResume on a finished thread does not invoke", async () => {
    const g = stubGraph();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleResume(ctxFor(g), { sessionId: await newSession(), payload: { action: "continue", answers: [] } as never }, FIRST);
    expect(g.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("a non-final attempt rethrows and leaves the stage untouched (pg-boss retries)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = stubGraph({ fail: new Error("ECONNRESET") });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id }, FIRST)).rejects.toThrow("ECONNRESET");
    await expect(handleStart(ctxFor(g), { sessionId: id }, { retryCount: 1, retryLimit: 2 })).rejects.toThrow("ECONNRESET");
    expect(await getSession(db, id)).toMatchObject({ stage: "transcribing", progress: 40, error: null });
    log.mockRestore();
  });

  it("the final attempt sets stage failed with the friendly message and rethrows", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = stubGraph({ fail: new Error("ECONNRESET secret") });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id }, LAST)).rejects.toThrow("ECONNRESET");
    expect(await getSession(db, id)).toMatchObject({
      stage: "failed",
      progress: 40,
      error: "Something went wrong while processing this video. Please try again.",
    });
    log.mockRestore();
  });

  it.each([
    ["TranscriptionError", new TranscriptionError("boom"), "Transcription failed: boom"],
    ["MissingApiKeyError", new MissingApiKeyError("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY is not set on the server."],
  ])("a deterministic %s fails the session at once and completes the job (no retry)", async (_name, err, message) => {
    const g = stubGraph({ fail: err });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, id)).toMatchObject({ stage: "failed", progress: 40, error: message });
  });

  it("handleResume follows the same attempt rules", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = { action: "skip" } as const;
    const id = await newSession();
    await setStage(db, id, "indexing", 70);
    const flaky = stubGraph({ next: ["finish"], fail: new Error("overloaded") });
    await expect(handleResume(ctxFor(flaky), { sessionId: id, payload }, FIRST)).rejects.toThrow("overloaded");
    expect((await getSession(db, id))!.stage).toBe("indexing");
    await expect(handleResume(ctxFor(flaky), { sessionId: id, payload }, LAST)).rejects.toThrow("overloaded");
    expect((await getSession(db, id))!.stage).toBe("failed");

    const keyless = stubGraph({ next: ["finish"], fail: new MissingApiKeyError("ANTHROPIC_API_KEY") });
    const id2 = await newSession();
    await expect(handleResume(ctxFor(keyless), { sessionId: id2, payload }, FIRST)).resolves.toBeUndefined();
    expect(await getSession(db, id2)).toMatchObject({ stage: "failed", error: "ANTHROPIC_API_KEY is not set on the server." });
    log.mockRestore();
  });
});

describe("queues without a consumer yet", () => {
  it("complete their jobs with a log line instead of retrying", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(notImplemented("track.burn")({ trackId: "x" }, FIRST)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("track.burn: not implemented yet"));
    log.mockRestore();
  });
});
