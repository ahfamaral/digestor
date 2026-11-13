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

/** Who a speech's text says is speaking: the printed name, and the party and state when the header gives them. */
export type SpeechHeader = { name: string | null; party: string | null; uf: string | null };

const SPOKEN_HEADER = /^\s*(?:O|A)\s+SRA?\.\s+([^(\n]+?)\s*\(([^)\n]*)\)/;
const WRITTEN_HEADER = /ENCAMINHAD[OA]\s+PEL[OA]\s+SRA?\.\s+DEPUTAD[OA]\s+([^(\n]+?)\s*\(/i;
const PARTY_UF = /(?:^|[\s/.])([\p{L}]+)\s+-\s+([A-Z]{2})(?=[\s.,;)]|$)/u;

/**
 * The speaker a speech's text prints: "O SR. MAURICIO MARCON (PL - RS. Pela ordem. …) - …" (name, party, state; a bloc
 * prefix such as "Bloco/REPUBLICANOS" keeps the party), or "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO ROBERTO
 * DUARTE (SEM REGISTRO …)" (name only). Nulls when the text has no header.
 */
export function speechHeader(text: string): SpeechHeader {
  const spoken = text.match(SPOKEN_HEADER);
  if (spoken) {
    const pu = spoken[2]!.match(PARTY_UF);
    return { name: spoken[1]!.trim(), party: pu ? pu[1]! : null, uf: pu ? pu[2]! : null };
  }
  const written = text.slice(0, 300).match(WRITTEN_HEADER);
  return { name: written ? written[1]!.trim() : null, party: null, uf: null };
}

/**
 * The Câmara's API files some speeches under two or more deputies whose names overlap (Mauricio Marcon's speeches also
 * under Marcon; Roberto Duarte's under Duarte Jr.). Given the copies of one speech (same text, same minute), returns the
 * ids filed under the wrong deputy: the copy whose party and state on the day match the header's is kept, else the one
 * whose name equals the printed name. When neither picks exactly one copy, nothing is returned (all are kept).
 */
export function misfiledCopies(text: string, copies: { id: number; name: string; party: string | null; uf: string | null }[]): number[] {
  if (copies.length < 2) return [];
  const h = speechHeader(text);
  const norm = (s: string | null) => (s ? normName(s) : "");
  let keep: typeof copies = [];
  if (h.party && h.uf) keep = copies.filter((c) => c.uf === h.uf && norm(c.party) === norm(h.party));
  if (keep.length !== 1 && h.name) keep = copies.filter((c) => norm(c.name) === norm(h.name));
  if (keep.length !== 1) return [];
  return copies.filter((c) => c.id !== keep[0]!.id).map((c) => c.id);
}

/** Video matches below this score are not stored: the page shows no video for that speech. */
export const VIDEO_MATCH_MIN = 0.6;

/** A speech the deputy sent in writing ("DISCURSO NA ÍNTEGRA ENCAMINHADO …", "SEM REGISTRO TAQUIGRÁFICO"): never spoken in the session. */
export function isWrittenOnly(text: string): boolean {
  const head = text.slice(0, 400).toUpperCase();
  return head.includes("SEM REGISTRO TAQUIGR") || /^\s*DISCURSO NA ÍNTEGRA ENCAMINHAD/.test(head);
}

/** The typed words, ranked first when they appear together (`phrase` of the speech searches); one word needs no boost. */
export const typedPhrase = (q: string): string | undefined => {
  const words = q.replace(/["()]/g, " ").trim();
  return /\s/.test(words) ? words : undefined;
};

/**
 * Search terms as full-text queries: what the person typed (`q`) keeps its search syntax (quotes, OR, -word); a
 * translated multi-word term is a phrase, so "violência contra a mulher" doesn't match those words scattered over a speech.
 */
export function phraseTerms(q: string, terms: string[]): string[] {
  const typed = normName(q);
  return terms.map((t) => (normName(t) === typed || !/\s/.test(t.trim()) ? t : `"${t.replace(/"/g, "")}"`));
}
