import {
  peopleInRange, personAt, speakerLabel, turnsOf, unconfirmedSpeakers,
  type Attribution, type AttributionSource, type Person, type Range, type Resolution, type Word,
} from "@digestor/core";
import { t } from "./i18n";

/** What the pages hand to client components: every person and attribution of a session, as plain data. */
export interface NamesData {
  persons: Person[];
  attributions: Attribution[];
}

export type VoiceLabel = ReturnType<typeof speakerLabel>;

const personMap = (names: NamesData) => new Map(names.persons.map((p) => [p.id, p]));

/** The label of one voice at one moment of the video. */
export function voiceLabel(names: NamesData, speakerId: string, atMs: number, sensitive: boolean): VoiceLabel {
  return speakerLabel(personAt(names.attributions, speakerId, atMs), personMap(names), speakerId, sensitive);
}

/** Voices speaking long enough inside `r` (no interjections), longest first; `atMs` is where the voice first speaks there. */
export function momentPeople(
  names: NamesData,
  words: Pick<Word, "startMs" | "endMs" | "speaker">[],
  r: Range,
  sensitive: boolean,
): { speakerId: string; label: VoiceLabel; resolution: Resolution; ms: number; atMs: number }[] {
  const persons = personMap(names);
  const key = (res: Resolution, speakerId: string) =>
    res.kind === "named" ? res.personId : res.kind === "anonymous" ? `anon:${speakerId}` : `none:${speakerId}`;
  return peopleInRange(words, names.attributions, r).map(({ speakerId, resolution, ms }) => ({
    speakerId,
    label: speakerLabel(resolution, persons, speakerId, sensitive),
    resolution,
    ms,
    // Where this name (not just this voice) first speaks in the range, so each entry resolves to its own name.
    atMs:
      words.find(
        (w) =>
          w.speaker === speakerId && w.endMs > r.startMs && w.startMs < r.endMs &&
          key(personAt(names.attributions, speakerId, w.startMs), speakerId) === key(resolution, speakerId),
      )?.startMs ?? r.startMs,
  }));
}

/** A voice to confirm: `range` is set when its name comes from a ranged row (one part of a split voice), and `confirm` is what Confirm sends. */
export interface UnconfirmedVoice {
  speakerId: string;
  label: VoiceLabel;
  atMs: number;
  range: Range | null;
  confirm: Record<string, unknown> | null;
}

/** Voices of a range whose name still needs confirming (a proposal, a conflict, or no name at all), longest first. */
export function unconfirmedVoices(
  names: NamesData,
  words: Pick<Word, "startMs" | "endMs" | "speaker">[],
  r: Range,
  sensitive: boolean,
): UnconfirmedVoice[] {
  return unconfirmedSpeakers(momentPeople(names, words, r, sensitive)).map(({ speakerId, label, atMs, resolution }) => ({
    speakerId, label, atMs, range: rowRange({ resolution }), confirm: confirmBody({ speakerId, resolution }),
  }));
}

/** The exact badge copy for a source. */
export function badgeText(source: AttributionSource): string {
  return t(`names.badge.${source}`);
}

/** A voice label as plain text (tooltips, option lists, compact lists): a proposed name carries its badge, "Ana Souza (from caption)". */
export function labelText(label: VoiceLabel): string {
  return label.proposed && label.badge ? `${label.text} (${badgeText(label.badge)})` : label.text;
}

/** One line for the badge tooltip: where the name comes from, and the evidence when there is one. */
export function evidenceLine(a: Attribution): string {
  const e = a.evidence;
  if (e.kind === "record") return t("names.evidenceRecord", { speech: e.speechId, score: e.score.toFixed(2) });
  if (e.kind === "caption") return t("names.evidenceCaption", { text: e.text });
  if (e.kind === "quote") return t("names.evidenceQuote", { from: t(`names.evidence.${a.source}`), quote: e.quote });
  return t(`names.evidence.${a.source}`);
}

/** Voices of the session with a name, for the Preview header ("N speakers · M named"). Unconfirmed names in sensitive profiles don't count. */
export function namedCount(names: NamesData, speakerIds: string[], sensitive: boolean): number {
  return speakerIds.filter((id) => voiceLabel(names, id, 0, sensitive).badge !== null).length;
}

/** A voice to show for a moment, clip or any range: who, and where in the video to resolve the name. */
export interface Voice {
  speakerId: string;
  atMs: number;
}

/**
 * The voices shown for a range: those speaking long enough, longest first. A range too short for any voice to count
 * (a punchline) shows the voices in `fallback` instead, resolved at the range start.
 */
export function rangeVoices(names: NamesData, words: Pick<Word, "startMs" | "endMs" | "speaker">[], r: Range, sensitive: boolean, fallback: string[] = []): Voice[] {
  const people = momentPeople(names, words, r, sensitive);
  if (people.length > 0) return people.map(({ speakerId, atMs }) => ({ speakerId, atMs }));
  return fallback.map((speakerId) => ({ speakerId, atMs: r.startMs }));
}

/** A voice is a main voice of the session when it speaks at least this share of the words' time. */
export const MIN_SPEAKER_SHARE = 0.1;
/** A turn this long makes a good ▶ sample. */
const SAMPLE_MIN_MS = 8_000;

export interface WhosWhoRow {
  speakerId: string;
  resolution: Resolution;
  /** Speaking time of this voice under this name. */
  ms: number;
  /** `ms` as a share of all speaking time. */
  share: number;
  sampleStartMs: number;
  /** The voice (all its names together) speaks at least `MIN_SPEAKER_SHARE`. */
  main: boolean;
}

/** One row per (voice, name at that moment): a voice the record named as two people gets two rows. Longest first. */
export function whosWhoRows(names: NamesData, words: Word[]): WhosWhoRow[] {
  const key = (res: Resolution, speakerId: string) =>
    res.kind === "named" ? res.personId : res.kind === "anonymous" ? `anon:${speakerId}` : res.kind === "conflict" ? `conflict:${speakerId}` : `none:${speakerId}`;
  const groups = new Map<string, { speakerId: string; resolution: Resolution; ms: number; firstMs: number; k: string }>();
  const perVoice = new Map<string, number>();
  let total = 0;
  for (const w of words) {
    const ms = w.endMs - w.startMs;
    if (ms <= 0) continue;
    const resolution = personAt(names.attributions, w.speaker, w.startMs);
    const k = key(resolution, w.speaker);
    const gk = `${w.speaker}\u0000${k}`;
    const cur = groups.get(gk);
    if (cur) cur.ms += ms;
    else groups.set(gk, { speakerId: w.speaker, resolution, ms, firstMs: w.startMs, k });
    perVoice.set(w.speaker, (perVoice.get(w.speaker) ?? 0) + ms);
    total += ms;
  }
  const turns = turnsOf(words);
  return [...groups.values()]
    .map((g) => {
      const long = turns.find(
        (tn) =>
          tn.speakerId === g.speakerId && tn.endMs - tn.startMs >= SAMPLE_MIN_MS &&
          key(personAt(names.attributions, g.speakerId, tn.startMs), g.speakerId) === g.k,
      );
      return {
        speakerId: g.speakerId,
        resolution: g.resolution,
        ms: g.ms,
        share: total > 0 ? g.ms / total : 0,
        sampleStartMs: long?.startMs ?? g.firstMs,
        main: total > 0 && (perVoice.get(g.speakerId) ?? 0) / total >= MIN_SPEAKER_SHARE,
      };
    })
    .sort((a, b) => b.ms - a.ms);
}

/** The range a row's name applies to when it comes from a ranged attribution (one turn of a split voice); null for a whole-voice row. */
export function rowRange(row: Pick<WhosWhoRow, "resolution">): Range | null {
  const res = row.resolution;
  const a = res.kind === "named" || res.kind === "anonymous" ? res.attribution : res.kind === "conflict" ? res.attributions[0] : undefined;
  return a && a.startMs !== null && a.endMs !== null ? { startMs: a.startMs, endMs: a.endMs } : null;
}

/** The body the names API gets for a row's Confirm button; null when the row has no single proposal. A ranged row confirms as a ranged human assignment. */
export function confirmBody(row: Pick<WhosWhoRow, "speakerId" | "resolution">): Record<string, unknown> | null {
  const res = row.resolution;
  if (res.kind !== "named" || res.confirmed) return null;
  const range = rowRange(row);
  return range
    ? { action: "assign", speakerId: row.speakerId, personId: res.personId, ...range }
    : { action: "confirm", speakerId: row.speakerId };
}

/** The body for a row's "No name" button. */
export function anonymousBody(row: WhosWhoRow): Record<string, unknown> {
  return { action: "anonymous", speakerId: row.speakerId, ...(rowRange(row) ?? {}) };
}

/** "Caption says Ana Souza · Transcript says Bia Lima" for a conflict row; null otherwise. */
export function conflictText(row: WhosWhoRow, names: NamesData): string | null {
  if (row.resolution.kind !== "conflict") return null;
  const persons = personMap(names);
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const a of row.resolution.attributions) {
    const name = a.personId ? persons.get(a.personId)?.displayName : undefined;
    if (!name || seen.has(`${a.source}${a.personId}`)) continue;
    seen.add(`${a.source}${a.personId}`);
    parts.push(t("names.conflictSays", { source: t(`names.conflictSource.${a.source}`), name }));
  }
  return parts.join(t("names.conflictJoin"));
}
