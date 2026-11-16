import type { SelectionStatus } from "@digestor/core";

/**
 * What the user clicked during this visit, per moment: the status shown (null = back to undecided) and when the server
 * accepted it (null while the write is still pending or in flight).
 */
export type StatusOverlay = Record<string, { status: SelectionStatus | null; confirmedAt: number | null }>;

/**
 * A refreshed page can carry a snapshot read just before a click's write landed. For this long after the write was
 * accepted, a snapshot that disagrees with the click is taken as older than it and the click stays shown.
 */
export const OVERLAY_GRACE_MS = 10_000;

/** The statuses the Briefing shows: the server's (from the last page load or refresh), with this visit's clicks on top. */
export function displayStatuses(server: Record<string, SelectionStatus>, overlay: StatusOverlay): Record<string, SelectionStatus> {
  const out: Record<string, SelectionStatus> = { ...server };
  for (const [id, { status }] of Object.entries(overlay)) {
    if (status) out[id] = status;
    else delete out[id];
  }
  return out;
}

/**
 * Called when fresh server data arrives (`router.refresh()` after Ask changed something, Find more, a re-analysis).
 * Keeps a click whose write is still pending (latest-wins: the user's newest choice is about to be saved) or was
 * accepted within `graceMs` (the snapshot may predate it); drops a click the server now agrees with, and one the
 * server contradicts after the grace (something else, such as an approved Ask change, changed it since). Returns the
 * same object when nothing changes.
 */
export function reconcileOverlay(
  overlay: StatusOverlay,
  server: Record<string, SelectionStatus>,
  now: number,
  graceMs: number = OVERLAY_GRACE_MS,
): StatusOverlay {
  let changed = false;
  const next: StatusOverlay = {};
  for (const [id, entry] of Object.entries(overlay)) {
    const agrees = (server[id] ?? null) === entry.status;
    const pending = entry.confirmedAt === null;
    const fresh = entry.confirmedAt !== null && now - entry.confirmedAt < graceMs;
    if (!agrees && (pending || fresh)) next[id] = entry;
    else changed = true;
  }
  return changed ? next : overlay;
}
