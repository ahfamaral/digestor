import { createHash } from "node:crypto";
import { z } from "zod";
import { normName } from "@digestor/core";

/**
 * The monitor's search by meaning, served by the worker (`POST /monitor/search`: local e5 embeddings of the official
 * speeches in Chroma). Internal only: `WORKER_URL` (prod: http://worker:8790 on the compose network; dev: the worker's
 * port published on the host's loopback). Anything but a good answer within 3 s is `ok: false`, never a throw: the
 * topic search then shows word results with a quiet note, and the worker is left alone for 30 s.
 */
export const DEFAULT_WORKER_URL = "http://127.0.0.1:8790";
export const MEANING_TOP = 100;
const CACHE_SIZE = 500;
/** The index changes once a day (the `monitor.embed` job); an hour keeps paging stable without serving stale days. */
const CACHE_MS = 60 * 60 * 1000;

export type SemanticResult = { keys: string[]; ok: boolean };
const reply = z.object({ hits: z.array(z.object({ speechKey: z.string(), score: z.number() })) });

/** After a failure the worker isn't asked again for 30 s, so a hung worker doesn't add 3 s to every search. */
const RETRY_AFTER_MS = 30_000;

const cache = new Map<string, { keys: string[]; at: number }>();
let downUntil = 0;
export function clearSemanticCache(): void {
  cache.clear();
  recordCache.clear();
  downUntil = 0;
}

export async function semanticSearch(
  q: string, o: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SemanticResult> {
  const key = normName(q);
  if (!key) return { keys: [], ok: true };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { keys: hit.keys, ok: true };
  if (Date.now() < downUntil) return { keys: [], ok: false };
  const base = (o.url ?? process.env.WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, "");
  try {
    const res = await (o.fetch ?? fetch)(`${base}/monitor/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, k: MEANING_TOP }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`worker answered ${res.status}`);
    const keys = reply.parse(await res.json()).hits.map((h) => h.speechKey);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, { keys, at: Date.now() });
    return { keys, ok: true };
  } catch (err) {
    downUntil = Date.now() + RETRY_AFTER_MS;
    console.warn("monitor search by meaning:", err instanceof Error ? err.message : err);
    return { keys: [], ok: false };
  }
}

export type RecordKindParam = "rollCalls" | "bills";
export type RecordHit = { id: string; score: number };
export type RecordSearchResult = { hits: RecordHit[]; ok: boolean };
/** Meaning hits asked for per text box: a deputy's own votes or bills, of which only the closest are kept (search.ts). */
export const RECORD_MEANING_K = 50;
const recordReply = z.object({ hits: z.array(z.object({ id: z.string(), score: z.number() })) });
const recordCache = new Map<string, { hits: RecordHit[]; at: number }>();

/**
 * A deputy's own roll calls or bills (`ids`, already filtered) ranked by meaning by the worker (`POST /monitor/search`
 * with `kind`), best first, with the cosine score. Same contract as `semanticSearch`: 3 s, cached an hour per kind,
 * query and id list, `ok: false` on any failure (never a throw); only a refused connection or a 5xx leaves the worker
 * alone for 30 s (shared with the speech search), never a timeout or a 404.
 */
export async function recordSearch(
  kind: RecordKindParam, q: string, ids: string[], o: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<RecordSearchResult> {
  const norm = normName(q);
  if (!norm || ids.length === 0) return { hits: [], ok: true };
  const key = `${kind}|${norm}|${createHash("sha1").update(ids.join(",")).digest("hex")}`;
  const hit = recordCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { hits: hit.hits, ok: true };
  if (Date.now() < downUntil) return { hits: [], ok: false };
  const base = (o.url ?? process.env.WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, "");
  try {
    const res = await (o.fetch ?? fetch)(`${base}/monitor/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, kind, ids, k: RECORD_MEANING_K }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      cache: "no-store",
    });
    if (!res.ok) throw new WorkerAnswered(res.status);
    const hits = recordReply.parse(await res.json()).hits;
    if (recordCache.size >= CACHE_SIZE) recordCache.delete(recordCache.keys().next().value!);
    recordCache.set(key, { hits, at: Date.now() });
    return { hits, ok: true };
  } catch (err) {
    // Only a worker that is down (connection refused, or a 5xx: Chroma down) stops the next searches for 30 s, the
    // speech search too. A slow answer (a cold index, many ids), a 404 (this index not built yet, right after an update)
    // or an odd body fails this search only.
    if (err instanceof TypeError || (err instanceof WorkerAnswered && err.status >= 500)) downUntil = Date.now() + RETRY_AFTER_MS;
    console.warn(`monitor ${kind} search by meaning:`, err instanceof Error ? err.message : err);
    return { hits: [], ok: false };
  }
}

class WorkerAnswered extends Error {
  constructor(readonly status: number) {
    super(`worker answered ${status}`);
  }
}

export type Passage = { speechKey: string; sentences: string[]; score: number };
export type PassagesResult = { ok: boolean; passages: Passage[] };
const passagesReply = z.object({
  passages: z.array(z.object({ speechKey: z.string(), sentences: z.array(z.string()), score: z.number() })),
});

/**
 * "Ask the record": the passages of these speeches closest in meaning to the question (`POST /monitor/passages`, the
 * worker's stored chunks scored against the question), best first, at most `perSpeech` each. Each passage is official
 * text split into sentences, as stored. A worker that is down, slow (10 s: speeches not indexed yet are embedded on
 * the fly) or answers garbage is `ok: false`, never a throw; only a refused connection or a 5xx leaves it alone for
 * 30 s (shared with the search).
 */
export async function speechPassages(
  q: string, speechKeys: string[], perSpeech: number, o: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PassagesResult> {
  if (!q.trim() || speechKeys.length === 0) return { ok: true, passages: [] };
  if (Date.now() < downUntil) return { ok: false, passages: [] };
  const base = (o.url ?? process.env.WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, "");
  try {
    const res = await (o.fetch ?? fetch)(`${base}/monitor/passages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, speechKeys, perSpeech }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      cache: "no-store",
    });
    if (!res.ok) throw new WorkerAnswered(res.status);
    return { ok: true, passages: passagesReply.parse(await res.json()).passages };
  } catch (err) {
    // Only a worker that is down (connection refused, 5xx) stops the next searches for 30 s; a slow answer (embedding
    // unindexed speeches on the fly) or an odd one fails this question only.
    if (err instanceof TypeError || (err instanceof WorkerAnswered && err.status >= 500)) downUntil = Date.now() + RETRY_AFTER_MS;
    console.warn("monitor passages:", err instanceof Error ? err.message : err);
    return { ok: false, passages: [] };
  }
}
