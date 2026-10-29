import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Word } from "@digestor/core";
import { createSession, getClip, replaceAiClips, saveTranscript, setStage, updateSession, type Clip } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { PATCH } from "./[id]/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());

const w = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs, speaker: "A", confidence: 0.9 });
// Boundaries: [0|1000], [2000|3000] (sentence end), [4500|6000] (sentence end), [7000|10000] (end)
const WORDS = [
  w("Hello", 1000, 1400),
  w("world.", 1500, 2000),
  w("Next", 3000, 3400),
  w("sentence", 3500, 4000),
  w("here.", 4100, 4500),
  w("Final", 6000, 6500),
  w("words.", 6600, 7000),
];

async function seed(stage: "awaiting_review" | "done" | "rendering" = "awaiting_review") {
  const s = await createSession(h.db, { title: "t", source: "upload" });
  await updateSession(h.db, s.id, { durationMs: 10_000 });
  await setStage(h.db, s.id, stage, 100);
  await saveTranscript(h.db, s.id, { language: "en", languageConfidence: 0.9, durationMs: 10_000, words: WORDS });
  const created = await replaceAiClips(h.db, s.id, [
    {
      title: "Parent",
      reason: "why",
      label: "heated",
      score: 90,
      startMs: 2850,
      endMs: 7150,
      children: [{ title: "Child", reason: "why", label: "light", score: 70, startMs: 2850, endMs: 4650 }],
    },
  ]);
  return { sessionId: s.id, parent: created[0]!, child: created[1]! };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(
    new Request("http://localhost/x", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }),
    ctx(id),
  );
const unchanged = async (c: Clip) => {
  const now = await getClip(h.db, c.id);
  expect([now?.startMs, now?.endMs, now?.status]).toEqual([c.startMs, c.endMs, c.status]);
};

describe("PATCH /api/clips/[id]", () => {
  it("404s for a malformed id and an unknown clip", async () => {
    expect((await patch("nope", { status: "approved" })).status).toBe(404);
    expect((await patch("00000000-0000-4000-8000-000000000000", { status: "approved" })).status).toBe(404);
  });

  it("400s for bodies that are neither a status nor start/end", async () => {
    const { parent } = await seed();
    for (const body of ["{", { status: "maybe" }, { start: "00:00:01" }, { start: 1, end: 2 }, {}]) {
      const res = await patch(parent.id, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    await unchanged(parent);
  });

  it("sets the status as the user", async () => {
    const { parent } = await seed();
    const res = await patch(parent.id, { status: "approved" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: parent.id, status: "approved" });
    expect((await getClip(h.db, parent.id))?.status).toBe("approved");
  });

  it("409s when the video is not in review", async () => {
    const { parent } = await seed("rendering");
    for (const body of [{ status: "approved" }, { start: "00:00:01", end: "00:00:05" }]) {
      const res = await patch(parent.id, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "This video isn't ready for review." });
    }
    await unchanged(parent);
  });

  it("allows edits once the video is done", async () => {
    const { parent } = await seed("done");
    expect((await patch(parent.id, { status: "rejected" })).status).toBe(200);
  });

  it("PATCH rejects end before start", async () => {
    const { parent } = await seed();
    for (const body of [
      { start: "00:00:05", end: "00:00:02" },
      { start: "00:00:05", end: "00:00:05" },
      { start: "00:00:01", end: "00:00:11" },
    ]) {
      const res = await patch(parent.id, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "End must be after start and within the video (hh:mm:ss)" });
    }
    await unchanged(parent);
  });

  it("PATCH rejects malformed time", async () => {
    const { parent } = await seed();
    for (const body of [
      { start: "1:2:3x", end: "00:00:05" },
      { start: "00:00:01", end: "1:2:3x" },
      { start: "00:00:01", end: "00:61:00" },
    ]) {
      const res = await patch(parent.id, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Use the format hh:mm:ss or hh:mm:ss.s" });
    }
    await unchanged(parent);
  });

  it("PATCH snaps saved bounds", async () => {
    const { parent } = await seed();
    // 3.5 s is mid-"sentence" → snaps to the sentence start (3000 − 150 pad); 6.2 s is mid-"Final" → after "words." (7000 + 150)
    const res = await patch(parent.id, { start: "00:00:03.5", end: "00:00:06.2" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Clip;
    expect([body.startMs, body.endMs]).toEqual([2850, 7150]);
    expect(body).toHaveProperty("outOfBounds", false);
    expect(body).toHaveProperty("renderStatus", "none");
    const saved = await getClip(h.db, parent.id);
    expect([saved?.startMs, saved?.endMs]).toEqual([2850, 7150]);
  });

  it("returns outOfBounds for a hot take moved outside its parent (2850–7150)", async () => {
    const { child } = await seed();
    const res = await patch(child.id, { start: "00:00:00.0", end: "00:00:04" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ startMs: 850, endMs: 4650, outOfBounds: true });
  });
});
