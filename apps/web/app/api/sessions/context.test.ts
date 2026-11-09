import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JOB_OPTIONS, QUEUES, type ContextCard } from "@digestor/core";
import { createSession, getSession, saveContextCard, setStage } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { GET, POST } from "./[id]/context/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => h.send.mockClear());

const fact = (value: string | null) => ({ value, source: value ? ("video" as const) : null, evidence: null });
const card: ContextCard = {
  language: fact("en"),
  profile: { value: "interview", confidence: 0.9, evidence: null },
  title: fact("Talk"),
  summary: "s",
  setting: fact(null),
  dateOrYear: fact(null),
  participants: [],
  sufficient: false,
  openQuestions: [],
};

async function session(stage: "awaiting_context" | "understanding") {
  const s = await createSession(h.db, { title: "t", source: "upload" });
  await setStage(h.db, s.id, stage, 50);
  return s.id;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), ctx(id));

describe("POST /api/sessions/[id]/context", () => {
  it("404s for a malformed id", async () => {
    expect((await post("nope", { action: "skip" })).status).toBe(404);
  });
  it("rejects the render action and malformed bodies with 400", async () => {
    const id = await session("awaiting_context");
    expect((await post(id, { action: "render" })).status).toBe(400);
    expect((await post(id, { action: "continue" })).status).toBe(400);
    expect((await POST(new Request("http://localhost/x", { method: "POST", body: "{" }), ctx(id))).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
    expect((await getSession(h.db, id))?.stage).toBe("awaiting_context");
  });
  it("409s when the session is not awaiting context", async () => {
    const id = await session("understanding");
    const res = await post(id, { action: "skip" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This video isn't waiting for context." });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("continue sets understanding and enqueues the resume payload", async () => {
    const id = await session("awaiting_context");
    const payload = { action: "continue", answers: [{ questionId: "q1", answer: "2019" }], cardEdits: { title: "New" } };
    const res = await post(id, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const s = await getSession(h.db, id);
    expect([s?.stage, s?.progress]).toEqual(["understanding", 55]);
    expect(h.send).toHaveBeenCalledWith(QUEUES.resume, { sessionId: id, payload }, { ...JOB_OPTIONS, singletonKey: id });
  });
  it("continue sends session.resume with the stored card's round", async () => {
    const id = await session("awaiting_context");
    await saveContextCard(h.db, id, card, 2);
    const payload = { action: "continue", answers: [], cardEdits: {} };
    expect((await post(id, payload)).status).toBe(200);
    expect(h.send).toHaveBeenCalledWith(QUEUES.resume, { sessionId: id, payload, round: 2 }, { ...JOB_OPTIONS, singletonKey: id });
  });
  it("skip sends the round too", async () => {
    const id = await session("awaiting_context");
    await saveContextCard(h.db, id, card, 1);
    expect((await post(id, { action: "skip" })).status).toBe(200);
    expect(h.send).toHaveBeenCalledWith(QUEUES.resume, { sessionId: id, payload: { action: "skip" }, round: 1 }, { ...JOB_OPTIONS, singletonKey: id });
  });
  it("a missing context card sends the resume without a round (the stage guard applies) and does not fail", async () => {
    const id = await session("awaiting_context");
    expect((await post(id, { action: "skip" })).status).toBe(200);
    const job = h.send.mock.calls[0]![1] as Record<string, unknown>;
    expect(job).toEqual({ sessionId: id, payload: { action: "skip" } });
    expect("round" in job).toBe(false);
  });
  it("404s for a valid uuid with no session", async () => {
    expect((await post("00000000-0000-4000-8000-000000000000", { action: "skip" })).status).toBe(404);
  });
  it("503s and restores awaiting_context when the enqueue fails", async () => {
    const id = await session("awaiting_context");
    h.send.mockRejectedValueOnce(new Error("db down"));
    const res = await post(id, { action: "skip" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect((await getSession(h.db, id))?.stage).toBe("awaiting_context");
    expect((await post(id, { action: "skip" })).status).toBe(200);
  });
  it("409s a second POST after the first transitioned", async () => {
    const id = await session("awaiting_context");
    expect((await post(id, { action: "skip" })).status).toBe(200);
    expect((await post(id, { action: "skip" })).status).toBe(409);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it("skip sets naming_speakers and enqueues", async () => {
    const id = await session("awaiting_context");
    expect((await post(id, { action: "skip" })).status).toBe(200);
    const s = await getSession(h.db, id);
    expect([s?.stage, s?.progress]).toEqual(["naming_speakers", 60]);
    expect(h.send).toHaveBeenCalledWith(QUEUES.resume, { sessionId: id, payload: { action: "skip" } }, { ...JOB_OPTIONS, singletonKey: id });
  });
  it("skip carries the card edits made on the screen", async () => {
    const id = await session("awaiting_context");
    const payload = { action: "skip", cardEdits: { profile: "trial" } };
    expect((await post(id, payload)).status).toBe(200);
    expect(h.send).toHaveBeenCalledWith(QUEUES.resume, { sessionId: id, payload }, { ...JOB_OPTIONS, singletonKey: id });
  });
});

describe("GET /api/sessions/[id]/context", () => {
  it("returns the card and round, 404 when none", async () => {
    const id = await session("awaiting_context");
    const req = new Request("http://localhost/x");
    expect((await GET(req, ctx(id))).status).toBe(404);
    await saveContextCard(h.db, id, card, 1);
    const res = await GET(req, ctx(id));
    expect(await res.json()).toEqual({ card, round: 1 });
    expect((await GET(req, ctx("nope"))).status).toBe(404);
  });
});
