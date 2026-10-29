import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, replaceAiClips } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { GET } from "./[id]/clips/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request("http://localhost/x"), ctx(id));
const base = { reason: "why", label: "heated" as const };

describe("GET /api/sessions/[id]/clips", () => {
  it("404s for a malformed id and an unknown session", async () => {
    expect((await get("nope")).status).toBe(404);
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("returns an empty list when there are no clips", async () => {
    const s = await createSession(h.db, { title: "t", source: "upload" });
    const res = await get(s.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("groups hot takes under their parent (parents by score) and keeps orphaned hot takes top-level", async () => {
    const s = await createSession(h.db, { title: "t", source: "upload" });
    const created = await replaceAiClips(h.db, s.id, [
      {
        ...base,
        title: "Low",
        score: 40,
        startMs: 0,
        endMs: 100_000,
        children: [{ ...base, title: "Low kid", score: 30, startMs: 10_000, endMs: 30_000 }],
      },
      {
        ...base,
        title: "High",
        score: 90,
        startMs: 200_000,
        endMs: 400_000,
        children: [
          { ...base, title: "High kid 2", score: 50, startMs: 300_000, endMs: 320_000 },
          { ...base, title: "High kid 1", score: 60, startMs: 210_000, endMs: 230_000 },
        ],
      },
    ]);
    const res = await get(s.id);
    const tree = (await res.json()) as { title: string; children: { title: string }[] }[];
    expect(tree.map((p) => [p.title, p.children.map((c) => c.title)])).toEqual([
      ["High", ["High kid 1", "High kid 2"]],
      ["Low", ["Low kid"]],
    ]);

    // Deleting the "Low" parent orphans its hot take, which then stands on its own.
    const low = created.find((c) => c.title === "Low")!;
    await h.db.execute(`DELETE FROM clips WHERE id = '${low.id}'`);
    const after = (await (await get(s.id)).json()) as { title: string; children: unknown[] }[];
    expect(after.map((p) => [p.title, p.children.length])).toEqual([
      ["High", 2],
      ["Low kid", 0],
    ]);
  });
});
