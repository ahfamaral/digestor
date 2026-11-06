import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  burnSignature, createClip, createSession, createTrack, finishClipRender, finishTrackBurn, getClip, listTracks, setTrackCues, updateSession, type Db,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { GET } from "./route";

let h: Harness;
let sessionId: string;
let c1: string;
let c2: string;

/** Marks a clip's render done with its key, and optionally burns a track, through the same functions the worker uses. */
async function markRendered(db: Db, sessionId: string, clipId: string, burnedLanguages: string[] = []) {
  const clip = (await getClip(db, clipId))!;
  expect(await finishClipRender(db, clipId, clip, { renderKey: `${sessionId}/clips/${clipId}.mp4` })).toBe("done");
  for (const tr of await listTracks(db, clipId))
    if (burnedLanguages.includes(tr.language))
      expect(await finishTrackBurn(db, tr.id, burnSignature(tr, clip), `${sessionId}/clips/${clipId}.${tr.language}.burned.mp4`)).toBe("done");
}

const call = (id: string, choice?: string) =>
  GET(new Request(`http://localhost/api/sessions/${id}/download${choice ? `?choice=${choice}` : ""}`), { params: Promise.resolve({ id }) });
const unzip = async (res: Response) => unzipSync(new Uint8Array(await res.arrayBuffer()));

beforeAll(async () => {
  h = createHarness();
  const seeded = await seedReadySession(h.db, [[10_000, 30_000, "Straße über Käse"], [40_000, 50_000, "Привет"]]);
  sessionId = seeded.sessionId;
  const mk = async (i: number) => (await createClip(h.db, { sessionId, ownerId: "owner", momentId: seeded.moments[i]!.id, startMs: i * 40_000, endMs: i * 40_000 + 5000, actor: "user" })).id;
  c1 = await mk(0);
  c2 = await mk(1);
  const dir = path.join(h.root, sessionId, "clips");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${c1}.mp4`), "plain-1");
  writeFileSync(path.join(dir, `${c1}.pt.burned.mp4`), "burned-1-pt");
  writeFileSync(path.join(dir, `${c1}.en.burned.mp4`), "burned-1-en");
  for (const lang of ["pt", "en"]) {
    const tr = (await createTrack(h.db, c1, lang))!;
    await setTrackCues(h.db, tr.id, [{ startMs: 0, endMs: 1500, original: "Hello", text: `Olá ${lang}`, missing: false }], "ready");
  }
  await markRendered(h.db, sessionId, c1, ["pt", "en"]);
  // c2: nothing rendered
  const tr2 = (await createTrack(h.db, c2, "pt"))!;
  await setTrackCues(h.db, tr2.id, [{ startMs: 0, endMs: 1000, original: "a", text: "b", missing: false }], "ready");
});
afterAll(() => h.cleanup());

describe("GET /api/sessions/[id]/download", () => {
  it("plain: the made videos only, stored not compressed, RFC 5987 header", async () => {
    const res = await call(sessionId, "plain");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]+\.zip"; filename\*=UTF-8''/);
    const files = await unzip(res);
    expect(Object.keys(files)).toEqual(["01 Strasse uber Kase.mp4"]);
    expect(strFromU8(files["01 Strasse uber Kase.mp4"]!)).toBe("plain-1");
  });

  it("files: video plus SRT and VTT rendered from the cues", async () => {
    const files = await unzip(await call(sessionId, "files"));
    expect(Object.keys(files).sort()).toEqual([
      "01 Strasse uber Kase.en.srt", "01 Strasse uber Kase.en.vtt", "01 Strasse uber Kase.mp4", "01 Strasse uber Kase.pt.srt", "01 Strasse uber Kase.pt.vtt",
      "02 clip.pt.srt", "02 clip.pt.vtt",
    ]);
    expect(strFromU8(files["01 Strasse uber Kase.pt.srt"]!)).toBe("1\n00:00:00,000 --> 00:00:01,500\nOlá pt\n");
    expect(strFromU8(files["01 Strasse uber Kase.en.vtt"]!)).toContain("Olá en");
  });

  it("burned: one file per language, named with the language", async () => {
    const files = await unzip(await call(sessionId, "burned"));
    expect(Object.keys(files).sort()).toEqual(["01 Strasse uber Kase.en.mp4", "01 Strasse uber Kase.pt.mp4"]);
    expect(strFromU8(files["01 Strasse uber Kase.pt.mp4"]!)).toBe("burned-1-pt");
  });

  it("a file missing on disk is left out, not a broken zip", async () => {
    const s = await createSession(h.db, { title: "Gone", source: "upload" });
    await updateSession(h.db, s.id, { stage: "ready", language: "en", durationMs: 10_000 });
    const clip = await createClip(h.db, { sessionId: s.id, ownerId: "owner", startMs: 0, endMs: 5000, actor: "user" });
    await markRendered(h.db, s.id, clip.id);
    expect((await call(s.id, "plain")).status).toBe(409);
  });

  it("409 when the zip would be empty, 404 unknown session, 400 bad choice", async () => {
    const s = await createSession(h.db, { title: "Empty", source: "upload" });
    const none = await call(s.id, "plain");
    expect(none.status).toBe(409);
    expect((await none.json()).error).toBe("Nothing to download yet.");
    expect((await call(sessionId, "burned")).status).toBe(200);
    expect((await call("22222222-2222-4222-8222-222222222222", "plain")).status).toBe(404);
    expect((await call("not-a-uuid", "plain")).status).toBe(404);
    expect((await call(sessionId, "nope")).status).toBe(400);
    expect((await call(sessionId)).status).toBe(400);
  });

  it("still serves what is stored after the video was removed (R30)", async () => {
    const s = await createSession(h.db, { title: "Old", source: "upload" });
    await updateSession(h.db, s.id, { stage: "ready", language: "en", durationMs: 10_000, videoDeletedAt: new Date() });
    const clip = await createClip(h.db, { sessionId: s.id, ownerId: "owner", startMs: 0, endMs: 5000, actor: "user" });
    mkdirSync(path.join(h.root, s.id, "clips"), { recursive: true });
    writeFileSync(path.join(h.root, s.id, "clips", `${clip.id}.mp4`), "kept");
    await markRendered(h.db, s.id, clip.id);
    const files = await unzip(await call(s.id, "plain"));
    expect(strFromU8(Object.values(files)[0]!)).toBe("kept");
  });
});
