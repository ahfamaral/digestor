import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { createDb, createSession, getSession, setStage, type Db } from "@digestor/core/server";
import { TranscriptionError } from "./transcribe/assemblyai.js";
import { MissingApiKeyError, QUEUE_OPTIONS, failureMessage, handleResume, processJobs, handleStart, type JobContext } from "./jobs.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function stubGraph(opts: { next?: string[]; fail?: Error; interrupted?: boolean } = {}) {
  const invoke = vi.fn(async (..._a: unknown[]) => {
    if (opts.fail) throw opts.fail;
    return {};
  });
  const getState = vi.fn(async (..._a: unknown[]) => ({ next: opts.next ?? [], tasks: opts.interrupted ? [{ interrupts: [{ value: 1 }] }] : [{ interrupts: [] }] }));
  return { invoke, getState };
}

describe("queue options and payloads", () => {
  it("QUEUE_OPTIONS", () => {
    expect(QUEUE_OPTIONS).toEqual({ expireInSeconds: 14400, retryLimit: 2, retryDelay: 30 });
  });
  it("invalid payload is logged and completed, valid ones are handled", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    const schema = { safeParse: (d: unknown) => (d === "ok" ? { success: true as const, data: d } : { success: false as const, error: { message: "bad" } }) };
    await processJobs("q", schema, handle, [{ data: "nope" }, { data: "ok" }]);
    expect(handle).toHaveBeenCalledTimes(1);
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
    await handleStart(ctxFor(g), { sessionId: id });
    const cfg = { configurable: { thread_id: id } };
    expect(g.invoke).toHaveBeenCalledWith({ sessionId: id }, cfg);
  });

  it("handleStart resumes from an existing checkpoint", async () => {
    const g = stubGraph({ next: ["transcribe"] });
    const id = await newSession();
    await handleStart(ctxFor(g), { sessionId: id });
    expect(g.invoke).toHaveBeenCalledWith(null, { configurable: { thread_id: id } });
  });

  it("handleResume passes a Command with the payload", async () => {
    const g = stubGraph({ next: ["context"], interrupted: true });
    const id = await newSession();
    const payload = { action: "continue", answers: [] } as never;
    await handleResume(ctxFor(g), { sessionId: id, payload });
    const [arg, cfg] = g.invoke.mock.calls[0]!;
    expect(arg).toBeInstanceOf(Command);
    expect((arg as Command).resume).toEqual(payload);
    expect(cfg).toEqual({ configurable: { thread_id: id } });
  });

  it("handleResume continues a mid-run thread with null (stale resume is not replayed)", async () => {
    const g = stubGraph({ next: ["find_clips"] });
    const id = await newSession();
    await handleResume(ctxFor(g), { sessionId: id, payload: { action: "continue", answers: [] } as never });
    expect(g.invoke).toHaveBeenCalledWith(null, { configurable: { thread_id: id } });
  });

  it("handleResume on a finished thread does not invoke", async () => {
    const g = stubGraph();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleResume(ctxFor(g), { sessionId: await newSession(), payload: { action: "continue", answers: [] } as never });
    expect(g.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("a throwing graph sets stage failed with friendly message and rethrows", async () => {
    const g = stubGraph({ fail: new TranscriptionError("boom") });
    const id = await newSession();
    await setStage(db, id, "transcribing", 40);
    await expect(handleStart(ctxFor(g), { sessionId: id })).rejects.toThrow("boom");
    const s = await getSession(db, id);
    expect(s?.stage).toBe("failed");
    expect(s?.error).toBe("Transcription failed: boom");
    expect(s?.progress).toBe(40);
  });
});
