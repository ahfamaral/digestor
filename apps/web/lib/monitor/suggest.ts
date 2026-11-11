import { normName } from "@digestor/core";

/** A row of `GET /api/monitor/deputies`. */
export type Suggestion = { externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null; inOffice: boolean };
export type PanelStatus = "idle" | "searching" | "none" | "error" | "list" | "listMore";

/** Control characters out, spaces collapsed (the route does the same). */
const clean = (q: string) => q.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();

/** What the deputy combobox's panel shows; `idle` (no panel) under 2 letters. */
export function panelStatus(s: { q: string; loading: boolean; error: boolean; rows: number; more: boolean }): PanelStatus {
  if (normName(clean(s.q)).length < 2) return "idle";
  if (s.loading) return "searching";
  if (s.error) return "error";
  if (s.rows === 0) return "none";
  return s.more ? "listMore" : "list";
}

/** At least 2 letters: worth asking the server. */
export const worthAsking = (q: string) => normName(clean(q)).length >= 2;
