/**
 * The credit line a clip starts with: the YouTube channel (or uploader) from the session's metadata, "" when there is
 * none. Prepare saves it on clips without a credit; a clip package sets it before its render, so the render isn't
 * made stale by Prepare saving it later.
 */
export function defaultCredit(session: { source: string; metadata: Record<string, unknown> }): string {
  if (session.source !== "youtube") return "";
  for (const key of ["channel", "uploader"]) {
    const v = session.metadata[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}
