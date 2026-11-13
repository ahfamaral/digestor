import { randomUUID } from "node:crypto";
import { ChromaClient } from "chromadb";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, replaceSpeechWindow, upsertMembers, type Db, type SpeechInput } from "@digestor/core/server";
import { FakeEmbedder } from "../search/embed.js";
import {
  chunkSpeech, embedSpeeches, MAX_FLY_CHUNKS, MeaningIndexMissingError, searchSpeechMeaning, speechPassages, splitSentences, type MeaningDeps,
} from "./embedSpeeches.js";

const sentence = (i: number, words = 12) => `Frase ${i} ${"palavra ".repeat(words).trim()}.`;

describe("splitSentences", () => {
  it("splits on sentence ends, keeps abbreviations' fragments joined to the next words", () => {
    expect(splitSentences("Sr. Presidente, o PL orienta \"não\". É importante! E agora? Fim.")).toEqual([
      "Sr. Presidente, o PL orienta \"não\".", "É importante!", "E agora?", "Fim.",
    ]);
    expect(splitSentences("   ")).toEqual([]);
    expect(splitSentences("Sem ponto final")).toEqual(["Sem ponto final"]);
  });
});

describe("chunkSpeech", () => {
  it("chunks of whole sentences up to ~1,000 characters, each starting with the previous chunk's last sentence", () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkSpeech(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const [i, c] of chunks.entries()) {
      expect(c.length).toBeLessThanOrEqual(1000);
      expect(c.endsWith(".")).toBe(true);
      expect(c.startsWith("Frase ")).toBe(true);
      if (i > 0) {
        const prevLast = splitSentences(chunks[i - 1]!).at(-1)!;
        expect(c.startsWith(prevLast)).toBe(true);
      }
    }
    // every sentence is in some chunk, in order
    expect(chunks.at(-1)!.endsWith(sentence(59))).toBe(true);
    const all = new Set(chunks.flatMap(splitSentences));
    expect(all.size).toBe(60);
  });

  it("leaves out the speaker header and splits an overlong sentence at word boundaries", () => {
    const header = "O SR. CABO GILBERTO SILVA (PL - PB. Pela ordem. Sem revisão do orador.) - ";
    const [first] = chunkSpeech(`${header}Sr. Presidente, o PL orienta "não".`);
    expect(first).toBe('Sr. Presidente, o PL orienta "não".');
    const written =
      "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO RUY CARNEIRO (SEM REGISTRO TAQUIGRÁFICO). O Sr. RUY CARNEIRO (PODE-PB) pronuncia o seguinte discurso: Senhor Presidente, as apostas cresceram.";
    expect(chunkSpeech(written)).toEqual(["Senhor Presidente, as apostas cresceram."]);
    const long = `${"longa ".repeat(400).trim()}.`;
    const parts = chunkSpeech(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("longa longa");
    expect(chunkSpeech("")).toEqual([]);
  });

  it("a short speech is one chunk", () => {
    expect(chunkSpeech("Uma frase. Outra frase.")).toEqual(["Uma frase. Outra frase."]);
  });
});

const chroma = new ChromaClient({ host: new URL(process.env.CHROMA_URL ?? "http://chroma:8000").hostname, port: 8000 });
const collections: string[] = [];
let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(async () => {
  for (const name of collections) await chroma.deleteCollection({ name }).catch(() => undefined);
  await close();
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE parl_speech_embeddings, parl_speeches, parl_members RESTART IDENTITY CASCADE`);
});

function deps(): MeaningDeps & { embedder: FakeEmbedder } {
  const collection = `test_monitor_${randomUUID().replaceAll("-", "")}`;
  collections.push(collection);
  return { db, chroma, embedder: new FakeEmbedder(), collection };
}
const speech = (startsAt: string, text: string, summary = ""): SpeechInput => ({ startsAt, phase: null, kind: null, summary, text, keywords: "" });
const longText = (tag: string) => Array.from({ length: 30 }, (_, i) => `${tag} ${sentence(i)}`).join(" ");

async function seed(texts: { startsAt: string; text: string; summary?: string }[]) {
  const ids = await upsertMembers(db, [{ house: "camara", externalId: 7, name: "A", party: null, uf: null, photoUrl: null }]);
  await replaceSpeechWindow(db, ids.get(7)!, "2026-02-01", "2026-11-11", texts.map((t) => speech(t.startsAt, t.text, t.summary)));
  const r = await db.execute<{ speech_key: string; text: string }>(sql`select speech_key, text from parl_speeches order by starts_at`);
  return { memberId: ids.get(7)!, rows: r.rows };
}

describe("embedSpeeches (real Chroma, FakeEmbedder)", () => {
  it("embeds new speeches once, then removes a revised text's old chunks", async () => {
    const d = deps();
    const { memberId, rows } = await seed([
      { startsAt: "2026-03-01T10:00", text: longText("Saúde") },
      { startsAt: "2026-03-02T10:00", text: "", summary: "Só o sumário publicado." },
      { startsAt: "2026-03-03T10:00", text: "" },
    ]);
    expect(await embedSpeeches(d)).toEqual({ added: 2, removed: 0 });
    const col = await chroma.getCollection({ name: d.collection! });
    const n = chunkSpeech(longText("Saúde")).length + 1;
    expect(await col.count()).toBe(n);
    const got = await col.get({ ids: [`${rows[0]!.speech_key}#0`], include: ["metadatas", "documents"] });
    expect(got.metadatas[0]).toMatchObject({ speechKey: rows[0]!.speech_key, memberId, startsAt: "2026-03-01T10:00" });
    expect(got.documents[0]).toBe(chunkSpeech(longText("Saúde"))[0]);

    // second run: nothing new
    expect(await embedSpeeches(d)).toEqual({ added: 0, removed: 0 });
    expect(await col.count()).toBe(n);

    // the transcription arrives for the summary-only speech: new key, the old key's chunk goes
    await replaceSpeechWindow(db, memberId, "2026-03-02", "2026-03-02", [speech("2026-03-02T10:00", "Agora o texto completo.")]);
    expect(await embedSpeeches(d)).toEqual({ added: 1, removed: 1 });
    expect(await col.count()).toBe(n);
    const old = await col.get({ where: { speechKey: rows[1]!.speech_key } });
    expect(old.ids).toEqual([]);
  });

  it("max limits how many speeches one run adds", async () => {
    const d = deps();
    await seed([
      { startsAt: "2026-03-01T10:00", text: "Um." },
      { startsAt: "2026-03-02T10:00", text: "Dois." },
      { startsAt: "2026-03-03T10:00", text: "Três." },
    ]);
    expect(await embedSpeeches(d, { max: 2 })).toEqual({ added: 2, removed: 0 });
    expect(await embedSpeeches(d, { max: 2 })).toEqual({ added: 1, removed: 0 });
  });
});

describe("searchSpeechMeaning / speechPassages", () => {
  it("one hit per speech (its best chunk), best first, k respected", async () => {
    const d = deps();
    const { rows } = await seed([
      { startsAt: "2026-03-01T10:00", text: longText("Saúde") },
      { startsAt: "2026-03-02T10:00", text: longText("Escola") },
      { startsAt: "2026-03-03T10:00", text: "Curto e direto." },
    ]);
    await embedSpeeches(d);
    const target = chunkSpeech(rows[1]!.text)[2]!;
    const hits = await searchSpeechMeaning(d, target, 10);
    expect(hits[0]).toMatchObject({ speechKey: rows[1]!.speech_key });
    expect(hits[0]!.score).toBeCloseTo(1, 3);
    expect(new Set(hits.map((h) => h.speechKey)).size).toBe(hits.length);
    expect(hits).toHaveLength(3);
    expect(await searchSpeechMeaning(d, target, 1)).toHaveLength(1);
  });

  it("an index that was never built says so", async () => {
    const d = deps();
    await expect(searchSpeechMeaning(d, "saúde", 10)).rejects.toBeInstanceOf(MeaningIndexMissingError);
  });

  it("passages: the speeches' best chunks as sentences, best first, perSpeech each; unindexed speeches scored on the fly", async () => {
    const d = deps();
    const { rows } = await seed([
      { startsAt: "2026-03-01T10:00", text: longText("Saúde") },
      { startsAt: "2026-03-02T10:00", text: longText("Escola") },
    ]);
    await embedSpeeches(d, { max: 1 }); // only the newest (Escola) is indexed
    const target = chunkSpeech(rows[0]!.text)[1]!;
    const out = await speechPassages(d, target, [rows[0]!.speech_key, rows[1]!.speech_key, "missing"], 2);
    expect(out[0]).toMatchObject({ speechKey: rows[0]!.speech_key, sentences: splitSentences(target) });
    expect(out[0]!.score).toBeCloseTo(1, 3);
    expect(out.filter((p) => p.speechKey === rows[0]!.speech_key)).toHaveLength(2);
    expect(out.filter((p) => p.speechKey === rows[1]!.speech_key)).toHaveLength(2);
    expect(out.map((p) => p.score)).toEqual([...out.map((p) => p.score)].sort((a, b) => b - a));
    expect(await speechPassages(d, target, [], 3)).toEqual([]);
  });

  it("passages embed at most MAX_FLY_CHUNKS chunks on the fly per call", async () => {
    const d = deps(); // never built: every speech is scored on the fly
    const huge = Array.from({ length: 2 * MAX_FLY_CHUNKS }, (_, i) => `Bloco ${i} ${"palavra ".repeat(150).trim()}.`).join(" ");
    const { rows } = await seed([{ startsAt: "2026-03-01T10:00", text: huge }]);
    expect(chunkSpeech(huge).length).toBeGreaterThan(MAX_FLY_CHUNKS);
    await speechPassages(d, "palavra", [rows[0]!.speech_key], 3);
    const passageCalls = d.embedder.calls.filter((c) => c.kind === "passage");
    expect(passageCalls.reduce((n, c) => n + c.texts.length, 0)).toBe(MAX_FLY_CHUNKS);
  });
});
