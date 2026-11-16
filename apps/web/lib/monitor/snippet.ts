// Client-safe: where a search snippet sits in its speech, so an excerpt cut mid-text gets a leading or trailing "…".

import { HIGHLIGHT_END, HIGHLIGHT_START } from "@digestor/core";

/** `ts_headline`'s default delimiter between two fragments of one snippet. */
const FRAGMENTS = " ... ";
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** Text before an excerpt that ends a sentence, a header ("… orador.) - ", "… discurso:") or the summary ("… "). */
const BOUNDARY_BEFORE = /[.!?…:;\-–—]\s*$/;
const ENDS_SENTENCE = /[.!?…]["”»)]?$/;

/**
 * Whether a snippet starts and ends inside its speech's text: `before` when text precedes it mid-sentence, `after`
 * when text follows and the snippet doesn't end a sentence. `summary` and `text` are joined as the search joins them
 * (" … "). A snippet that can't be placed (rewritten whitespace aside) gets neither.
 */
export function snippetCuts(snippet: string, summary: string | null, text: string | null): { before: boolean; after: boolean } {
  const plain = squash(snippet.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, ""));
  const source = squash([summary, text].filter(Boolean).join(" … "));
  const parts = plain.split(FRAGMENTS).map(squash).filter(Boolean);
  if (parts.length === 0) return { before: false, after: false };
  const first = source.indexOf(parts[0]!);
  if (first < 0) return { before: false, after: false };
  const lastPart = parts.at(-1)!;
  const last = parts.length === 1 ? first : source.indexOf(lastPart, first);
  if (last < 0) return { before: first > 0 && !BOUNDARY_BEFORE.test(source.slice(0, first)), after: false };
  const end = last + lastPart.length;
  return {
    before: first > 0 && !BOUNDARY_BEFORE.test(source.slice(0, first)),
    after: end < source.length && !ENDS_SENTENCE.test(lastPart),
  };
}
