/** Calls `refresh` every `intervalMs` until the returned stop function is called. */
export function startRefreshLoop(refresh: () => void, intervalMs: number): () => void {
  const timer = setInterval(refresh, intervalMs);
  return () => clearInterval(timer);
}
