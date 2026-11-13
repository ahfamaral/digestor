import type { ChromaClient, Collection } from "chromadb";
import { SPEECH_HEADER_PATTERN } from "@digestor/core";
import {
  forgetEmbeddings, markEmbedded, orphanEmbeddings, speechesToEmbed, speechTextsByKeys, type Db,
} from "@digestor/core/server";
import type { Embedder } from "../search/embed.js";

/**
 * The monitor's meaning index: the Câmara's speeches (official text, or the official summary while the text is not
 * published) in chunks of whole sentences, embedded with the local e5 model into one Chroma collection. The search
 * only finds and ranks official text; nothing here writes text.
 */
export const MONITOR_COLLECTION = "monitor_camara_speeches";
export const MONITOR_EMBED_QUEUE = "monitor.embed";
/** Daily, an hour after the refresh (09:00 UTC) brought new and revised speeches. */
export const MONITOR_EMBED_CRON = "0 10 * * *";
/**
 * Speeches one daily run embeds at most (about 10 minutes of CPU in the live worker); a day brings tens. A larger
 * backlog (a new server, a revised year) catches up over the following days, or at once with `scripts/monitor-embed.ts`.
 */
export const MONITOR_EMBED_MAX_PER_RUN = 2000;

export const MAX_CHUNK_CHARS = 1000;
/** Speeches embedded per round (one Chroma write and one bookkeeping write per round). */
const SPEECH_BATCH = 32;
const CHROMA_BATCH = 200;

export type MeaningDeps = { db: Db; chroma: ChromaClient; embedder: Embedder; collection?: string };
export type MeaningHit = { speechKey: string; score: number };
export type Passage = { speechKey: string; sentences: string[]; score: number };

/** The index has never been built (prod before the first embed run): the search answers 503 and the web falls back. */
export class MeaningIndexMissingError extends Error {
  constructor() {
    super("The meaning index has not been built yet.");
    this.name = "MeaningIndexMissingError";
  }
}

// ── Sentences and chunks ─────────────────────────────────────────────────────────────────────────────────────────

/** Words the stenography abbreviates with a period that never end a sentence ("Sr. Presidente", "V.Exa.", "nº"). */
const ABBREVIATIONS = new Set(
  [
    "sr", "sra", "srs", "sras", "dr", "dra", "drs", "dras", "exa", "exas", "exmo", "exma", "sa", "v", "vv", "prof", "profa", "dep", "deps",
    "gen", "cel", "cap", "ten", "sgt", "maj", "art", "arts", "inc", "nº", "pág", "fl", "fls", "av", "jr", "st", "sto", "sta",
  ].map((w) => w.normalize("NFC")),
);

/**
 * Sentences of plain text: a break after ".", "!", "?" or "…" (and any closing quotes or brackets) followed by space
 * and a capital letter, digit, quote or dash; not after a known abbreviation or a single capital letter (initials).
 */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out: string[] = [];
  const re = /[.!?…]+["'”’)\]]*(?=\s+["'“‘(\[—–-]?[\p{Lu}\d])/gu;
  let start = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const end = m.index + m[0].length;
    if (m[0].startsWith(".")) {
      const word = /([\p{L}º.]+)$/u.exec(t.slice(start, m.index))?.[1] ?? "";
      const last = word.split(".").pop()!.toLowerCase();
      if (ABBREVIATIONS.has(last) || /^\p{Lu}$/u.test(word.split(".").pop()!)) continue;
    }
    out.push(t.slice(start, end).trim());
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** The speech's header (spoken or sent in writing, core's `SPEECH_HEADER_PATTERN`): who, not what. */
const HEADER = new RegExp(SPEECH_HEADER_PATTERN, "i");

/** An overlong sentence cut at word boundaries into pieces of at most `max` characters. */
function cutLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of sentence.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > max && cur) {
      out.push(cur);
      cur = word.slice(0, max);
    } else cur = next.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A speech's text as chunks of whole sentences up to `max` characters; each chunk after the first starts with the
 * previous chunk's last sentence (one sentence of overlap) when that still fits. The speaker header is left out.
 */
export function chunkSpeech(text: string, max = MAX_CHUNK_CHARS): string[] {
  const pieces = splitSentences(text.replace(HEADER, "")).flatMap((s) => (s.length > max ? cutLong(s, max) : [s]));
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const piece of pieces) {
    if (cur.length > 0 && len + 1 + piece.length > max) {
      chunks.push(cur.join(" "));
      const last = cur[cur.length - 1]!;
      cur = last.length + 1 + piece.length <= max ? [last] : [];
      len = cur.length ? last.length : 0;
    }
    len += (cur.length ? 1 : 0) + piece.length;
    cur.push(piece);
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

// ── Index ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isNotFound = (err: unknown) => err instanceof Error && /not.?found|does not exist/i.test(`${err.name} ${err.message}`);

function openOrCreate(d: MeaningDeps): Promise<Collection> {
  return d.chroma.getOrCreateCollection({
    name: d.collection ?? MONITOR_COLLECTION,
    embeddingFunction: null,
    configuration: { hnsw: { space: "cosine" } },
  });
}

async function open(d: MeaningDeps): Promise<Collection | null> {
  try {
    return await d.chroma.getCollection({ name: d.collection ?? MONITOR_COLLECTION });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function slices<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Brings the index up to date: deletes the chunks of keys no speech has any more (a revised text gets a new key),
 * then embeds speeches not in the index yet, newest first (`max`: at most that many this run). Safe to rerun after a
 * crash: chunk ids are `${speechKey}#${i}` (upsert), and a speech is recorded only after its chunks are stored.
 * `added`/`removed` count speeches.
 */
export async function embedSpeeches(d: MeaningDeps, opts: { max?: number } = {}): Promise<{ added: number; removed: number }> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const col = await openOrCreate(d);
  const orphans = await orphanEmbeddings(d.db);
  for (const part of slices(orphans, 100)) {
    await col.delete({ where: { speechKey: { $in: part } } });
    await forgetEmbeddings(d.db, part);
  }
  let added = 0;
  while (added < max) {
    const todo = await speechesToEmbed(d.db, Math.min(SPEECH_BATCH, max - added));
    if (todo.length === 0) break;
    const rows = todo.flatMap((s) =>
      chunkSpeech(s.text || s.summary).map((text, i) => ({
        id: `${s.speechKey}#${i}`, text, meta: { speechKey: s.speechKey, memberId: s.memberId, startsAt: s.startsAt },
      })),
    );
    const vectors = await d.embedder.embed(rows.map((r) => r.text), "passage");
    if (vectors.length !== rows.length) throw new Error("The embedder returned the wrong number of vectors.");
    for (const [i, part] of slices(rows, CHROMA_BATCH).entries()) {
      await col.upsert({
        ids: part.map((r) => r.id),
        embeddings: vectors.slice(i * CHROMA_BATCH, i * CHROMA_BATCH + part.length),
        documents: part.map((r) => r.text),
        metadatas: part.map((r) => r.meta),
      });
    }
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.meta.speechKey, (per.get(r.meta.speechKey) ?? 0) + 1);
    // a speech whose text has no sentence (a bare header) is recorded with 0 chunks, so it is not picked again
    await markEmbedded(d.db, todo.map((s) => ({ speechKey: s.speechKey, chunks: per.get(s.speechKey) ?? 0 })));
    added += todo.length;
  }
  return { added, removed: orphans.length };
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Chunks fetched per wanted speech: a speech has ~3 chunks on average, so most of them are one speech's neighbours. */
const CHUNKS_PER_HIT = 4;
const MAX_CHUNKS = 1000;

/** The speeches nearest the query, best chunk per speech, best first (cosine similarity, 1 = identical). */
export async function searchSpeechMeaning(d: MeaningDeps, q: string, k: number): Promise<MeaningHit[]> {
  const col = await open(d);
  if (!col) throw new MeaningIndexMissingError();
  const [vector] = await d.embedder.embed([q], "query");
  if (!vector) return [];
  const res = await col.query({ queryEmbeddings: [vector], nResults: Math.min(k * CHUNKS_PER_HIT, MAX_CHUNKS), include: ["metadatas", "distances"] });
  const best = new Map<string, number>();
  for (const [i, meta] of (res.metadatas[0] ?? []).entries()) {
    const key = meta?.speechKey;
    if (typeof key !== "string" || best.has(key)) continue;
    best.set(key, 1 - (res.distances[0]?.[i] ?? 1));
    if (best.size === k) break;
  }
  return [...best].map(([speechKey, score]) => ({ speechKey, score }));
}

/** Chunks embedded on the fly per passages call (speeches not in the index yet): about 15 s of CPU at most. */
export const MAX_FLY_CHUNKS = 200;

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

/**
 * The passages of these speeches closest to the query: each speech's chunks scored against it, the best `perSpeech`
 * of each, as sentences, best first. Speeches not in the index yet (published since the last run) are chunked and
 * embedded on the fly, at most `MAX_FLY_CHUNKS` chunks per call (a speech's later chunks beyond that are not scored);
 * unknown keys are skipped.
 */
export async function speechPassages(d: MeaningDeps, q: string, keys: string[], perSpeech: number): Promise<Passage[]> {
  if (keys.length === 0) return [];
  const [qv] = await d.embedder.embed([q], "query");
  if (!qv) return [];
  const byKey = new Map<string, { text: string; vector: number[] }[]>();
  const col = await open(d);
  if (col) {
    const got = await col.get({ where: { speechKey: { $in: keys } }, include: ["documents", "metadatas", "embeddings"] });
    for (const [i, meta] of got.metadatas.entries()) {
      const key = meta?.speechKey;
      const text = got.documents[i];
      const vector = got.embeddings[i];
      if (typeof key !== "string" || !text || !vector) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), { text, vector: Array.from(vector) }]);
    }
  }
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) {
    const texts = await speechTextsByKeys(d.db, missing);
    const rows = texts
      .flatMap((s) => chunkSpeech(s.text || s.summary).map((text) => ({ key: s.speechKey, text })))
      .slice(0, MAX_FLY_CHUNKS);
    const vectors = await d.embedder.embed(rows.map((r) => r.text), "passage");
    for (const [i, r] of rows.entries()) byKey.set(r.key, [...(byKey.get(r.key) ?? []), { text: r.text, vector: vectors[i]! }]);
  }
  const out: Passage[] = [];
  for (const [speechKey, chunks] of byKey) {
    const scored = chunks.map((c) => ({ speechKey, sentences: splitSentences(c.text), score: dot(qv, c.vector) }));
    out.push(...scored.sort((a, b) => b.score - a.score).slice(0, perSpeech));
  }
  return out.sort((a, b) => b.score - a.score);
}
