import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSession, updateSession } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { setEventTimingForTests } from "@/lib/sessionEvents";
import { GET } from "./[id]/events/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
  setEventTimingForTests({ pollMs: 20, heartbeatMs: 60 });
});
afterEach(() => setEventTimingForTests({ pollMs: 20, heartbeatMs: 60 }));
afterAll(async () => {
  setEventTimingForTests(null);
  await h.cleanup();
});

const ID = "00000000-0000-4000-8000-000000000000";
const call = (id: string, signal?: AbortSignal) =>
  GET(new Request(`http://localhost/api/sessions/${id}/events`, { signal }), { params: Promise.resolve({ id }) });

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}
const events = (text: string) =>
  text
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)));

describe("GET /api/sessions/[id]/events", () => {
  it("404s for a malformed id and an unknown session", async () => {
    expect((await call("nope")).status).toBe(404);
    expect((await call(ID)).status).toBe(404);
  });

  it("emits the current stage first and closes on ready", async () => {
    const s = await createSession(h.db, { title: "t", source: "upload" });
    await updateSession(h.db, s.id, { stage: "ready", progress: 100, language: "pt", profile: "interview" });
    const res = await call(s.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const text = await readAll(res);
    expect(events(text)).toEqual([
      { stage: "ready", progress: 100, error: null, language: "pt", profile: "interview", hasVideo: true },
    ]);
  });

  it("sends only changes, sends heartbeats, and closes on failed with the error", async () => {
    const s = await createSession(h.db, { title: "t", source: "upload" });
    await updateSession(h.db, s.id, { stage: "preparing", progress: 10 });
    const res = await call(s.id);
    const pending = readAll(res);
    await new Promise((r) => setTimeout(r, 200)); // several polls with no change
    await updateSession(h.db, s.id, { stage: "transcribing", progress: 30, hasVideo: false }); // ingest found no picture
    await new Promise((r) => setTimeout(r, 100));
    await updateSession(h.db, s.id, { stage: "failed", error: "No speech was detected in this video." });
    const text = await pending;
    expect(events(text).map((e) => e.stage)).toEqual(["preparing", "transcribing", "failed"]);
    expect(events(text).map((e) => e.hasVideo)).toEqual([true, false, false]);
    expect(events(text)[2].error).toBe("No speech was detected in this video.");
    expect(text).toContain(": ping\n\n");
  });

  it("stops polling when the client disconnects", async () => {
    const s = await createSession(h.db, { title: "t", source: "upload" });
    await updateSession(h.db, s.id, { stage: "preparing" });
    const ac = new AbortController();
    const res = await call(s.id, ac.signal);
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    const end = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return "closed";
      })(),
      new Promise((r) => setTimeout(() => r("open"), 1000)),
    ]);
    expect(end).toBe("closed");
  });
});
