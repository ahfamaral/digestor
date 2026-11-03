/**
 * Wrong-password throttle per client address: 5 wrong attempts in 10 minutes block the address until its oldest
 * attempt leaves the window. In memory with pruning: fine because the web app is a single process; a restart clears it.
 */
const MAX_WRONG = 5;
const WINDOW_MS = 10 * 60_000;

let clock: () => number = Date.now;
const wrong = new Map<string, number[]>();

function recent(ip: string): number[] {
  const cutoff = clock() - WINDOW_MS;
  const kept = (wrong.get(ip) ?? []).filter((t) => t > cutoff);
  if (kept.length > 0) wrong.set(ip, kept);
  else wrong.delete(ip);
  return kept;
}

/** First `x-forwarded-for` value, else "unknown". */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function isThrottled(ip: string): boolean {
  return recent(ip).length >= MAX_WRONG;
}

export function recordWrong(ip: string): void {
  const kept = recent(ip);
  kept.push(clock());
  wrong.set(ip, kept);
  if (wrong.size > 1000) for (const key of [...wrong.keys()]) recent(key); // prune addresses whose window has passed
}

export function clearWrong(ip: string): void {
  wrong.delete(ip);
}

export function resetLoginThrottleForTests(now: () => number = Date.now): void {
  clock = now;
  wrong.clear();
}
