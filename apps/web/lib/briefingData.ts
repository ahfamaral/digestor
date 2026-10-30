import { sliceWords, speakerShares, toSentences, type Word } from "@digestor/core";

/**
 * The transcript's own words inside the moment (never the model's evidence, which isn't checked as verbatim), cut to
 * `maxChars` graphemes at a word boundary when there is one, with "…".
 */
export function momentExcerpt(words: Word[], range: { startMs: number; endMs: number }, maxChars = 220): string {
  const text = toSentences(sliceWords(words, range))
    .map((s) => s.text)
    .join(" ")
    .trim();
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  if (graphemes.length <= maxChars) return text;
  let cut = graphemes.slice(0, maxChars).join("");
  const space = cut.lastIndexOf(" ");
  if (space > cut.length / 2) cut = cut.slice(0, space);
  // Drop sentence punctuation (Latin, CJK, Arabic) at the cut so it doesn't read ".…".
  return `${cut.trimEnd().replace(/[\s.,;:!?。、，；：！？،؛]+$/u, "")}…`;
}

/**
 * The session's speakers for the Focus picker, sorted by id, each with its share of the spoken words (whole percent,
 * from the stored transcript). Speakers seen only in moments, or a session without a transcript, get `share: null`.
 */
export function speakerOptions(words: Word[], momentSpeakers: string[]): { id: string; share: number | null }[] {
  const shares = words.length > 0 ? speakerShares(words) : {};
  const ids = [...new Set([...Object.keys(shares), ...momentSpeakers])].sort();
  return ids.map((id) => ({ id, share: id in shares ? Math.round(shares[id]! * 100) : null }));
}

/**
 * Selections on moments outside the current analysis: how many, and the newest version holding them
 * ("You have N selections on an earlier analysis (v<n>)."). Null when there are none.
 */
export function earlierSelections(
  rows: { analysisId: string; version: number; count: number }[],
  currentAnalysisId: string,
): { count: number; version: number } | null {
  const other = rows.filter((r) => r.analysisId !== currentAnalysisId && r.count > 0);
  if (other.length === 0) return null;
  return { count: other.reduce((n, r) => n + r.count, 0), version: Math.max(...other.map((r) => r.version)) };
}
