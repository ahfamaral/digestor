import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import { getSession } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { POST } from "./route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => h.send.mockClear());

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/sessions/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/sessions/youtube", () => {
  it("youtube route rejects a playlist link", async () => {
    const res = await post({ url: "https://www.youtube.com/playlist?list=PL1234567890" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Paste a link to a single YouTube video." });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ link: "https://youtu.be/jNQXAC9IVRw" })).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("youtube route creates a youtube session and enqueues start", async () => {
    const res = await post({ url: " https://youtu.be/jNQXAC9IVRw?t=3 ", hint: "First video ever" });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const canonical = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    expect(await getSession(h.db, sessionId)).toMatchObject({
      source: "youtube",
      sourceUrl: canonical,
      title: canonical,
      stage: "uploaded",
      originalKey: null,
      hint: "First video ever",
    });
    expect(h.send).toHaveBeenCalledWith(QUEUES.start, { sessionId }, { ...JOB_OPTIONS, singletonKey: sessionId });
  });
});
