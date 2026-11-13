import { randomUUID } from "node:crypto";
import { ChromaClient } from "chromadb";
import { afterAll, describe, expect, it } from "vitest";
import type { Word } from "@digestor/core";
import { FakeEmbedder } from "./embed.js";
import { chunkTranscript, collectionName, deleteSessionIndex, indexSession, indexedSessions, searchTranscript } from "./index.js";

/** ~3 s sentences, 300 ms per word, so a 3-minute talk is about 60 sentences. */
function talk(sentences: number, speakerOf: (i: number) => string = () => "A"): Word[] {
  const words: Word[] = [];
  let t = 0;
  for (let s = 0; s < sentences; s++) {
    for (let w = 0; w < 10; w++) {
      const last = w === 9;
      words.push({ text: last ? `sentence${s}word${w}.` : `s${s}w${w}`, startMs: t, endMs: t + 280, confidence: 0.9, speaker: speakerOf(s) });
      t += 300;
    }
  }
  return words;
}

describe("chunkTranscript", () => {
  it("windows are 45–60 s and end on sentence boundaries", () => {
    const words = talk(60, (i) => (i < 30 ? "A" : "B"));
    const chunks = chunkTranscript(words);
    expect(chunks.length).toBeGreaterThan(2);
    for (const [i, c] of chunks.entries()) {
      const len = c.endMs - c.startMs;
      expect(len).toBeLessThanOrEqual(60_000);
      if (i < chunks.length - 1) expect(len).toBeGreaterThanOrEqual(45_000);
      expect(c.text.trimEnd().endsWith(".")).toBe(true);
    }
    expect(chunks[0]!.startMs).toBe(0);
    expect(chunks.at(-1)!.endMs).toBe(words.at(-1)!.endMs);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    expect(chunks.flatMap((c) => c.speakers)).toContain("B");
  });
  it("returns nothing for an empty transcript", () => expect(chunkTranscript([])).toEqual([]));
});

const chroma = new ChromaClient({ host: new URL(process.env.CHROMA_URL ?? "http://chroma:8000").hostname, port: 8000 });
const created: string[] = [];
const newSession = () => {
  const id = randomUUID();
  created.push(id);
  return id;
};
afterAll(async () => {
  for (const id of created) await deleteSessionIndex(chroma, id).catch(() => undefined);
});

describe("indexSession / searchTranscript (real Chroma, FakeEmbedder)", () => {
  const deps = { chroma, embedder: new FakeEmbedder() };

  it("indexSession is idempotent", async () => {
    const id = newSession();
    const words = talk(40);
    const n = await indexSession(deps, id, words);
    expect(n).toBe(chunkTranscript(words).length);
    expect(await indexSession(deps, id, words)).toBe(n);
    const col = await chroma.getCollection({ name: collectionName(id) });
    expect(await col.count()).toBe(n);
  });

  it("searchTranscript returns the closest chunk first", async () => {
    const id = newSession();
    const words = talk(60);
    await indexSession(deps, id, words);
    const target = chunkTranscript(words)[1]!;
    const hits = await searchTranscript(deps, id, target.text, 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ text: target.text, startMs: target.startMs, endMs: target.endMs, speakers: ["A"] });
    expect(hits[0]!.score).toBeCloseTo(1, 3);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("indexedSessions keeps only the sessions that have a collection", async () => {
    const id = newSession();
    await indexSession(deps, id, talk(20));
    const missing = randomUUID();
    expect(await indexedSessions(chroma, [missing, id])).toEqual(new Set([id]));
    await deleteSessionIndex(chroma, id);
    expect(await indexedSessions(chroma, [id])).toEqual(new Set());
  });

  it("deleteSessionIndex tolerates a missing collection", async () => {
    await expect(deleteSessionIndex(chroma, randomUUID())).resolves.toBeUndefined();
  });
});

describe.skipIf(!process.env.RUN_E5_TEST)("real e5 model", () => {
  it("ranks a translated sentence above an unrelated one", { timeout: 300_000 }, async () => {
    const { createE5Embedder } = await import("./embed.js");
    const e = createE5Embedder();
    const [q] = await e.embed(["Where was the minister born?"], "query");
    const [a, b] = await e.embed(["O ministro nasceu em Lisboa.", "A receita leva três ovos e farinha."], "passage");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(q!.length).toBe(384);
    expect(dot(q!, a!)).toBeGreaterThan(dot(q!, b!));
  });
});
