// Client-safe helpers for the parliament monitor.

/** Lower-case, accents stripped, spaces collapsed: what `parl_members.name_norm` holds and name search compares. */
export function normName(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Markers `ts_headline` puts around matched words (control characters, so they never occur in official text). */
export const HIGHLIGHT_START = "\u0001";
export const HIGHLIGHT_END = "\u0002";

/** A snippet split into plain and matched parts, rendered as text and `<mark>` (never as HTML). */
export function splitHighlights(s: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  for (const part of s.split(HIGHLIGHT_START)) {
    const end = part.indexOf(HIGHLIGHT_END);
    const [hit, rest] = end === -1 ? ["", part] : [part.slice(0, end), part.slice(end + 1)];
    if (hit) out.push({ text: hit.replaceAll(HIGHLIGHT_END, ""), hit: true });
    if (rest) out.push({ text: rest.replaceAll(HIGHLIGHT_END, ""), hit: false });
  }
  return out;
}
