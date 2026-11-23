import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Word } from "@digestor/core";
import {
  LocalStorage, createClip, editTrackCues, setTrackCues, updateClip, createDb, createSession, createTrack, getTrack, saveTranscript, updateSession, type Db,
} from "@digestor/core/server";
import { FakeLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";
import { handlePrepareTrack } from "../jobs.js";
import { prepareTrack } from "./tracks.js";

const words: Word[] = ["Hello", "there.", "Second", "sentence."].map((text, i) => ({
  text, startMs: 10_000 + i * 600, endMs: 10_000 + i * 600 + 500, speaker: "A", confidence: 1,
}));

let db: Db;
let close: () => Promise<void>;
let root: string;
let storage: LocalStorage;
beforeAll(async () => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
  root = await mkdtemp(path.join(os.tmpdir(), "digestor-tracks-"));
  storage = new LocalStorage(root);
});
afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

async function seed(language: string) {
  const s = await createSession(db, { title: "T", source: "upload" });
  await updateSession(db, s.id, { language: "en" });
  await saveTranscript(db, s.id, { language: "en", languageConfidence: 1, durationMs: 60_000, words });
  const clip = await createClip(db, { sessionId: s.id, ownerId: "owner", startMs: 9_000, endMs: 15_000, actor: "user" });
  const track = (await createTrack(db, clip.id, language))!;
  return { s, clip, track };
}
const deps = (llm: FakeLLM) => ({ db, llm });

describe("prepareTrack", () => {
  it("keeps the original text for the session language and writes no files", async () => {
    const { track } = await seed("en");
    const llm = new FakeLLM([]);
    await prepareTrack(deps(llm), track.id);
    expect(llm.calls).toHaveLength(0);
    const t = (await getTrack(db, track.id))!;
    expect(t.status).toBe("ready");
    expect(t.cues.length).toBeGreaterThan(0);
    expect(t.cues.every((c) => c.text === c.original && !c.missing)).toBe(true);
    expect(t.cues.every((c) => (c.words?.length ?? 0) > 0)).toBe(true);
    expect(t.srtKey).toBeNull();
    expect(t.vttKey).toBeNull();
  });

  it("translates other languages and flags gaps", async () => {
    const { track } = await seed("pt");
    const llm = new FakeLLM([() => ({ lines: [{ n: 1, text: "Olá." }] })]);
    await prepareTrack(deps(llm), track.id);
    const t = (await getTrack(db, track.id))!;
    expect(t.cues[0]).toMatchObject({ original: "Hello there.", text: "Olá.", missing: false });
    expect(t.cues.length).toBe(2);
    expect(t.cues[1]).toMatchObject({ text: "", missing: true });
    expect(t.status).toBe("ready");
  });
});

describe("prepareTrack records the cut it was built for (R27)", () => {
  it("stores the clip's bounds with the cues", async () => {
    const { track } = await seed("en");
    await prepareTrack(deps(new FakeLLM([])), track.id);
    expect(await getTrack(db, track.id)).toMatchObject({ status: "ready", builtStartMs: 9_000, builtEndMs: 15_000 });
  });
  it("a trim that lands while the cues are being translated leaves the track outdated", async () => {
    const { clip, track } = await seed("pt");
    const llm = new FakeLLM([
      async () => {
        await updateClip(db, clip.id, { endMs: 14_000 }, "user");
        return { lines: [{ n: 1, text: "Olá." }, { n: 2, text: "Segunda." }] };
      },
    ]);
    await prepareTrack(deps(llm), track.id);
    expect(await getTrack(db, track.id)).toMatchObject({ status: "outdated", builtStartMs: 9_000, builtEndMs: 15_000 });
  });
});

describe("prepareTrack guards", () => {
  it("does nothing for a track that is no longer preparing (edits survive a duplicate job)", async () => {
    const { track } = await seed("en");
    await prepareTrack(deps(new FakeLLM([])), track.id);
    await editTrackCues(db, track.id, [{ i: 0, text: "Edited" }]);
    await prepareTrack(deps(new FakeLLM([])), track.id);
    expect((await getTrack(db, track.id))!.cues[0]!.text).toBe("Edited");
  });
  it("a clip with no speech fails the track with a friendly message", async () => {
    const s = await createSession(db, { title: "Quiet", source: "upload" });
    await updateSession(db, s.id, { language: "en" });
    await saveTranscript(db, s.id, { language: "en", languageConfidence: 1, durationMs: 60_000, words });
    const clip = await createClip(db, { sessionId: s.id, ownerId: "owner", startMs: 40_000, endMs: 45_000, actor: "user" });
    const track = (await createTrack(db, clip.id, "en"))!;
    await prepareTrack(deps(new FakeLLM([])), track.id);
    expect(await getTrack(db, track.id)).toMatchObject({ status: "failed", error: "This clip has no speech to subtitle." });
  });
  it("a final-attempt failure never downgrades a ready track", async () => {
    const { track } = await seed("en");
    await prepareTrack(deps(new FakeLLM([])), track.id);
    await handlePrepareTrack({ db, deps: deps(new FakeLLM([])) as never }, { trackId: track.id }, { retryCount: 3, retryLimit: 3 });
    expect((await getTrack(db, track.id))!.status).toBe("ready");
  });
});

describe("handlePrepareTrack", () => {
  it("a missing key fails the track and completes the job", async () => {
    const { track } = await seed("pt");
    const llm = new FakeLLM([() => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); }]);
    await handlePrepareTrack({ db, deps: deps(llm) as never }, { trackId: track.id }, { retryCount: 0, retryLimit: 3 });
    expect((await getTrack(db, track.id))!.status).toBe("failed");
  });
  it("other errors fail the track only on the final attempt and rethrow", async () => {
    const { track } = await seed("pt");
    const boom = () => { throw new Error("boom"); };
    const ctx = { db, deps: deps(new FakeLLM([boom, boom])) as never };
    await expect(handlePrepareTrack(ctx, { trackId: track.id }, { retryCount: 0, retryLimit: 3 })).rejects.toThrow("boom");
    expect((await getTrack(db, track.id))!.status).toBe("preparing");
    await expect(handlePrepareTrack(ctx, { trackId: track.id }, { retryCount: 3, retryLimit: 3 })).rejects.toThrow("boom");
    expect((await getTrack(db, track.id))!.status).toBe("failed");
  });
});
