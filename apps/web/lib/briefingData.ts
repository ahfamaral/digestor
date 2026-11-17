import { FOCUS_MIN_MS, peopleInRange, personAt, sliceWords, toSentences, type MomentWithHighlights, type Word } from "@digestor/core";
import { voiceLabel, type NamesData } from "./names";

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

export type FocusOption =
  | { kind: "person"; personId: string; share: number }
  | { kind: "voice"; speakerId: string; share: number };

/**
 * The Focus picker's options: people (every name a voice has, resolved word by word, a person across voices counted
 * once) by speaking share, then the voices with no name to show. `share` is a whole percent of the spoken words.
 * With `sensitive`, an unconfirmed name is not listed as a person: that speech stays with its voice, as "Speaker X".
 */
export function focusOptions(names: NamesData, words: Word[], sensitive = false): FocusOption[] {
  const persons = new Map<string, number>();
  const voices = new Map<string, number>();
  let total = 0;
  for (const w of words) {
    const ms = w.endMs - w.startMs;
    if (ms <= 0) continue;
    total += ms;
    const res = personAt(names.attributions, w.speaker, w.startMs);
    if (res.kind === "named" && (res.confirmed || !sensitive) && names.persons.some((p) => p.id === res.personId)) {
      persons.set(res.personId, (persons.get(res.personId) ?? 0) + ms);
    } else voices.set(w.speaker, (voices.get(w.speaker) ?? 0) + ms);
  }
  const pct = (ms: number) => (total > 0 ? Math.round((ms / total) * 100) : 0);
  const byShare = <T extends [string, number]>(a: T, b: T) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return [
    ...[...persons].sort(byShare).map(([personId, ms]): FocusOption => ({ kind: "person", personId, share: pct(ms) })),
    ...[...voices].sort(byShare).map(([speakerId, ms]): FocusOption => ({ kind: "voice", speakerId, share: pct(ms) })),
  ];
}

/**
 * Who speaks in each moment, for the person filter: a person passes a moment when their words there add up to at least
 * FOCUS_MIN_MS, summed across voices and names (the Focus rule, not the export check's per-voice rule). Built once.
 */
export function peopleByMoment(
  moments: Pick<MomentWithHighlights, "id" | "startMs" | "endMs">[],
  names: NamesData,
  words: Word[],
  sensitive = false,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of moments) {
    const ms = new Map<string, number>();
    for (const e of peopleInRange(sliceWords(words, m), names.attributions, m, 0)) {
      // Same rule as focusOptions: in a sensitive profile an unconfirmed name is not a person here.
      if (e.resolution.kind === "named" && (e.resolution.confirmed || !sensitive)) ms.set(e.resolution.personId, (ms.get(e.resolution.personId) ?? 0) + e.ms);
    }
    out.set(m.id, new Set([...ms].filter(([, v]) => v >= FOCUS_MIN_MS).map(([id]) => id)));
  }
  return out;
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

/**
 * The granularity of the nearest approved moment above `momentId` in the shown tree (null: none, or the moment isn't
 * shown). The moment's own approval doesn't count.
 */
export function insideApproved(
  momentId: string,
  approvedIds: ReadonlySet<string>,
  tree: { moment: { id: string; granularity: string }; children: unknown[] }[],
): string | null {
  type Node = (typeof tree)[number];
  const walk = (nodes: Node[], nearest: string | null): string | null | undefined => {
    for (const n of nodes) {
      if (n.moment.id === momentId) return nearest;
      const found = walk(n.children as Node[], approvedIds.has(n.moment.id) ? n.moment.granularity : nearest);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(tree, null) ?? null;
}

/**
 * The counted "Longest speech" moment is stored with the speaker id the analysis saw ("Longest speech: E"); show the
 * name the session has now instead (the same rule as the speaker lines: a sensitive profile names only confirmed
 * people, else "Speaker E"). Other moments are returned unchanged.
 */
export function withCurrentSpeakerNames<M extends MomentWithHighlights>(moments: M[], names: NamesData, sensitive: boolean): M[] {
  return moments.map((m) => {
    const speaker = m.speakers[0];
    if (!m.highlights.some((h) => h.type === "longest_speech")) return m;
    const title = currentSpeakerTitle(m, names, sensitive);
    if (title === m.title) return m;
    const label = voiceLabel(names, speaker, m.startMs, sensitive).text;
    return { ...m, title, why: m.why.replace(`by ${speaker},`, `by ${label},`) };
  });
}

/**
 * A moment's title as `withCurrentSpeakerNames` shows it, for screens that load the moment without its highlights
 * (Prepare, Export): only the counted moment whose title is still "Longest speech: <speaker id>" is renamed.
 */
export function currentSpeakerTitle(
  m: { origin: string; speakers: string[]; title: string; startMs: number },
  names: NamesData,
  sensitive: boolean,
): string {
  const speaker = m.speakers[0];
  if (m.origin !== "counted" || m.speakers.length !== 1 || m.title !== `Longest speech: ${speaker}`) return m.title;
  return `Longest speech: ${voiceLabel(names, speaker, m.startMs, sensitive).text}`;
}
