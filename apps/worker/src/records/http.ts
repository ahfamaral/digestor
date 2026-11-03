/** Shared HTTP helpers of the official-record clients (Senado, Câmara). */

/** Per-call limits; tests set `delayMs` to 0. */
export const httpTiming = { timeoutMs: 30_000, delayMs: 1000 };

/**
 * GET with a 30 s timeout. Network failures, timeouts, 429 and 5xx are transient: one retry after a short delay, then a
 * plain error (the job rethrows and pg-boss retries it). `label` names the API in error messages ("Senado").
 */
export async function get(url: string, accept: string, f: typeof fetch, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await f(url, { headers: { accept }, signal: AbortSignal.timeout(httpTiming.timeoutMs) });
      if (res.status >= 500 || res.status === 429) throw new Error(`${label} API answered ${res.status}.`);
      return res;
    } catch (err) {
      if (attempt >= 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, httpTiming.delayMs));
    }
  }
}

/** A JSON GET: a 404 is `{ status: 404 }`, any other non-2xx throws. */
export async function getJson(url: string, f: typeof fetch, label: string): Promise<{ status: number; body: unknown }> {
  const res = await get(url, "application/json", f, label);
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`${label} API answered ${res.status}.`);
  return { status: 200, body: await res.json() };
}

/**
 * `fn` over `items` with at most `limit` in flight; results keep the items' order. Once any item has failed no new item
 * is started (the rest of a long sweep must not run on while the caller's retry is already scheduled); it then rejects.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
