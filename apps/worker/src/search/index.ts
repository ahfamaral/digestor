import type { ChromaClient } from "chromadb";
import { toSentences, type Sentence, type Word } from "@digestor/core";
import type { Embedder } from "./embed.js";

export type SearchDeps = { chroma: ChromaClient; embedder: Embedder };
export type Chunk = { id: string; text: string; startMs: number; endMs: number; speakers: string[] };
export type SearchHit = { text: string; startMs: number; endMs: number; speakers: string[]; score: number };

const MIN_CHUNK_MS = 45_000;
const MAX_CHUNK_MS = 60_000;
const ADD_BATCH = 100;

/** One Chroma collection per session. Chroma names allow [a-zA-Z0-9._-]. */
export const collectionName = (sessionId: string): string => `session_${sessionId.replaceAll("-", "")}`;

/** 45-60 s windows built from whole sentences; the last chunk may be shorter, an overlong sentence stands alone. */
export function chunkTranscript(words: Word[]): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Sentence[] = [];
  const flush = () => {
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (!first || !last) return;
    chunks.push({
      id: `c${chunks.length}`,
      text: cur.map((s) => s.text).join(" "),
      startMs: first.startMs,
      endMs: last.endMs,
      speakers: [...new Set(cur.map((s) => s.speaker))],
    });
    cur = [];
  };
  for (const sentence of toSentences(words)) {
    const first = cur[0];
    if (first && sentence.endMs - first.startMs > MAX_CHUNK_MS) flush();
    cur.push(sentence);
    if (sentence.endMs - cur[0]!.startMs >= MIN_CHUNK_MS) flush();
  }
  flush();
  return chunks;
}

/** Deletes and re-creates the session's collection, so a retry never duplicates chunks. Returns the chunk count. */
export async function indexSession(deps: SearchDeps, sessionId: string, words: Word[]): Promise<number> {
  const chunks = chunkTranscript(words);
  const embeddings = await deps.embedder.embed(
    chunks.map((c) => c.text),
    "passage",
  );
  if (embeddings.length !== chunks.length) throw new Error("The embedder returned the wrong number of vectors.");
  const name = collectionName(sessionId);
  await deleteSessionIndex(deps.chroma, sessionId);
  const collection = await deps.chroma.getOrCreateCollection({
    name,
    embeddingFunction: null,
    configuration: { hnsw: { space: "cosine" } },
  });
  for (let i = 0; i < chunks.length; i += ADD_BATCH) {
    const part = chunks.slice(i, i + ADD_BATCH);
    await collection.add({
      ids: part.map((c) => c.id),
      embeddings: embeddings.slice(i, i + ADD_BATCH),
      documents: part.map((c) => c.text),
      metadatas: part.map((c) => ({ startMs: c.startMs, endMs: c.endMs, speakers: c.speakers })),
    });
  }
  return chunks.length;
}

/** Nearest chunks first; score is cosine similarity (1 = identical). */
export async function searchTranscript(deps: SearchDeps, sessionId: string, query: string, k = 6): Promise<SearchHit[]> {
  const collection = await deps.chroma.getCollection({ name: collectionName(sessionId) });
  const [vector] = await deps.embedder.embed([query], "query");
  if (!vector) return [];
  const res = await collection.query({ queryEmbeddings: [vector], nResults: k, include: ["documents", "metadatas", "distances"] });
  const hits: SearchHit[] = [];
  for (const [i, text] of (res.documents[0] ?? []).entries()) {
    const meta = res.metadatas[0]?.[i];
    if (text === null || !meta) continue;
    hits.push({
      text,
      startMs: Number(meta.startMs),
      endMs: Number(meta.endMs),
      speakers: Array.isArray(meta.speakers) ? meta.speakers.map(String) : [],
      score: 1 - (res.distances[0]?.[i] ?? 1),
    });
  }
  return hits;
}

/** Drops the session's collection; a missing collection is not an error. */
export async function deleteSessionIndex(chroma: ChromaClient, sessionId: string): Promise<void> {
  try {
    await chroma.deleteCollection({ name: collectionName(sessionId) });
  } catch (err) {
    if (err instanceof Error && /not.?found|does not exist/i.test(`${err.name} ${err.message}`)) return;
    throw err;
  }
}
