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
