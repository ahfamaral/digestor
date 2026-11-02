import {
  peopleInRange, personAt, speakerLabel,
  type Attribution, type AttributionSource, type Person, type Range, type Word,
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
  words: Word[],
  r: Range,
  sensitive: boolean,
): { speakerId: string; label: VoiceLabel; ms: number; atMs: number }[] {
  const persons = personMap(names);
  return peopleInRange(words, names.attributions, r).map(({ speakerId, resolution, ms }) => ({
    speakerId,
    label: speakerLabel(resolution, persons, speakerId, sensitive),
    ms,
    atMs: words.find((w) => w.speaker === speakerId && w.endMs > r.startMs && w.startMs < r.endMs)?.startMs ?? r.startMs,
  }));
}

/** The exact badge copy for a source. */
export function badgeText(source: AttributionSource): string {
  return t(`names.badge.${source}`);
}

/** One line for the badge tooltip: where the name comes from, and the evidence when there is one. */
export function evidenceLine(a: Attribution): string {
  const e = a.evidence;
  if (e.kind === "record") return t("names.evidenceRecord", { speech: e.speechId, score: e.score.toFixed(2) });
  if (e.kind === "caption") return t("names.evidenceCaption", { text: e.text });
  if (e.kind === "quote") return t("names.evidenceQuote", { quote: e.quote });
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
export function rangeVoices(names: NamesData, words: Word[], r: Range, sensitive: boolean, fallback: string[] = []): Voice[] {
  const people = momentPeople(names, words, r, sensitive);
  if (people.length > 0) return people.map(({ speakerId, atMs }) => ({ speakerId, atMs }));
  return fallback.map((speakerId) => ({ speakerId, atMs: r.startMs }));
}
