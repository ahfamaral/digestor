import {
  peopleInRange, personAt, speakerLabel, speakersInRange, turnsOf, unconfirmedSpeakers,
  type Attribution, type AttributionSource, type Person, type Range, type Resolution, type Word,
} from "@digestor/core";
import { t } from "./i18n";

/** What the pages hand to client components: every person and attribution of a session, as plain data. */
export interface NamesData {
  persons: Person[];
  attributions: Attribution[];
}

export type VoiceLabel = ReturnType<typeof speakerLabel>;

const voiceIndex = new WeakMap<Attribution[], Map<string, Attribution[]>>();
/** The attributions of one voice (indexed once per attributions array: `personAt` filters by voice anyway). */
function voiceAtts(names: NamesData, speakerId: string): Attribution[] {
  let idx = voiceIndex.get(names.attributions);
  if (!idx) {
    idx = new Map();
    for (const a of names.attributions) {
      const list = idx.get(a.speakerId);
      if (list) list.push(a);
      else idx.set(a.speakerId, [a]);
    }
    voiceIndex.set(names.attributions, idx);
  }
  return idx.get(speakerId) ?? [];
}

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
  return peopleInRange(words, names.attributions, r).map(({ speakerId, resolution, ms }) => ({
    speakerId,
    label: speakerLabel(resolution, persons, speakerId, sensitive),
    resolution,
    ms,
    atMs: firstSpeakingAs(names, words, r, speakerId, resolution),
  }));
}

/** Where this name (not just this voice) first speaks in the range, so each entry resolves to its own name. */
function firstSpeakingAs(names: NamesData, words: Pick<Word, "startMs" | "endMs" | "speaker">[], r: Range, speakerId: string, resolution: Resolution): number {
  const key = (res: Resolution) =>
    res.kind === "named" ? res.personId : res.kind === "anonymous" ? `anon:${speakerId}` : `none:${speakerId}`;
  return (
    words.find(
      (w) =>
        w.speaker === speakerId && w.endMs > r.startMs && w.startMs < r.endMs &&
        key(personAt(names.attributions, speakerId, w.startMs)) === key(resolution),
    )?.startMs ?? r.startMs
  );
}


/** The key `whosWhoRows` groups a voice's words by: the person, or "no name" / "conflict" per voice. */
function resolutionKey(res: Resolution, speakerId: string): string {
  return res.kind === "named" ? res.personId : res.kind === "anonymous" ? `anon:${speakerId}` : res.kind === "conflict" ? `conflict:${speakerId}` : `none:${speakerId}`;
}

/** True when the voice has current ranged non-human rows: it is named part by part, so a whole-voice human write would shadow them (the API refuses one for record rows). */
function namedPartByPart(names: NamesData, speakerId: string): boolean {
  return voiceAtts(names, speakerId).some(
    (a) => a.speakerId === speakerId && a.source !== "human" && a.supersededAt === null && a.status !== "rejected" && a.startMs !== null && a.endMs !== null,
  );
}

/**
 * The contiguous spans of a voice's words that resolve to one group (turns, split where the name changes): the ranges a
 * row for the part of a part-by-part voice that no ranged row names acts on. `within` keeps only the spans touching a range.
 */
function remainderSpans(names: NamesData, words: Pick<Word, "startMs" | "endMs" | "speaker">[], speakerId: string, key: string, within?: Range, unconfirmedOnly = false): Range[] {
  return spansWhere(names, words, speakerId, (res) => resolutionKey(res, speakerId) === key && resolutionRanges(res).length === 0 && (!unconfirmedOnly || (res.kind === "named" && !res.confirmed)), within);
}

/** Contiguous spans of a voice's words whose resolution passes `test` (a turn ends where another voice speaks or `test` fails). */
function spansWhere(names: NamesData, words: Pick<Word, "startMs" | "endMs" | "speaker">[], speakerId: string, test: (res: Resolution) => boolean, within?: Range): Range[] {
  const spans: Range[] = [];
  let open: Range | null = null;
  const atts = voiceAtts(names, speakerId);
  for (const w of words) {
    if (w.speaker !== speakerId || !test(personAt(atts, speakerId, w.startMs))) {
      open = null;
      continue;
    }
    if (open) open.endMs = w.endMs;
    else {
      open = { startMs: w.startMs, endMs: w.endMs };
      spans.push(open);
    }
  }
  return within ? spans.filter((r) => r.endMs > within.startMs && r.startMs < within.endMs) : spans;
}

const mergeRanges = (...lists: Range[][]): Range[] => {
  const m = new Map<string, Range>();
  for (const l of lists) for (const r of l) m.set(`${r.startMs}-${r.endMs}`, r);
  return [...m.values()].sort((x, y) => x.startMs - y.startMs);
};

/**
 * Confirm's body for a name at one moment of a part-by-part voice that resolves through a whole-voice row (which a
 * whole-voice confirm would 409 on): a ranged assignment for the parts of the given range (the moment or clip) that no
 * ranged row names, so a record turn of another senator on the same voice is never relabelled. Otherwise `confirmBody`.
 */
export function voiceConfirmBody(names: NamesData, speakerId: string, resolution: Resolution, range?: Range): Record<string, unknown> | null {
  const body = confirmBody({ speakerId, resolution });
  if (body && body.action === "confirm" && range && resolution.kind === "named" && namedPartByPart(names, speakerId)) {
    const free = subtractRanges(range, ranged(names, speakerId));
    return free.length > 0 ? { action: "assign", speakerId, personId: resolution.personId, ...rangeFields(free) } : null;
  }
  return body;
}

/** The voice's current, non-rejected ranged rows of any source: the parts the voice's whole-voice resolution doesn't reach. */
function ranged(names: NamesData, speakerId: string): Range[] {
  return voiceAtts(names, speakerId).flatMap((a) =>
    a.supersededAt === null && a.status !== "rejected" && a.startMs !== null && a.endMs !== null ? [{ startMs: a.startMs, endMs: a.endMs }] : [],
  );
}

/** `r` minus every range in `cut`, as sorted, non-empty pieces. */
function subtractRanges(r: Range, cut: Range[]): Range[] {
  let pieces: Range[] = [r];
  for (const c of cut) {
    pieces = pieces.flatMap((p) =>
      c.endMs <= p.startMs || c.startMs >= p.endMs
        ? [p]
        : [
            ...(c.startMs > p.startMs ? [{ startMs: p.startMs, endMs: c.startMs }] : []),
            ...(c.endMs < p.endMs ? [{ startMs: c.endMs, endMs: p.endMs }] : []),
          ],
    );
  }
  return pieces;
}

/** A voice to confirm: `range` is set when its name comes from a ranged row (one part of a split voice), and `confirm` is what Confirm sends. */
export interface UnconfirmedVoice {
  speakerId: string;
  label: VoiceLabel;
  atMs: number;
  range: Range | null;
  /** Every range a change applies to: the ranged rows' own, or the spans no ranged row names in a voice named part by part. */
  ranges: Range[];
  confirm: Record<string, unknown> | null;
}

/** All the ranges of this name's proposed turns that touch `r` (a senator the record names for several turns); the first range for a conflict or a human "no name". */
function unconfirmedRangesIn(names: NamesData, words: Pick<Word, "startMs" | "endMs" | "speaker">[], speakerId: string, resolution: Resolution, r: Range): Range[] {
  const first = rowRange({ resolution });
  if (!first) return remainderSpans(names, words, speakerId, resolutionKey(resolution, speakerId), r);
  if (resolution.kind !== "named") return [first];
  const found = new Map<string, Range>([[`${first.startMs}-${first.endMs}`, first]]);
  const atts = voiceAtts(names, speakerId);
  for (const w of words) {
    if (w.speaker !== speakerId || w.endMs <= r.startMs || w.startMs >= r.endMs) continue;
    const res = personAt(atts, speakerId, w.startMs);
    if (res.kind !== "named" || res.confirmed || res.personId !== resolution.personId) continue;
    for (const x of resolutionRanges(res)) found.set(`${x.startMs}-${x.endMs}`, x);
  }
  return [...found.values()].sort((a, b) => a.startMs - b.startMs);
}

/** Voices of a range whose name still needs confirming (a proposal, a conflict, or no name at all), longest first. */
export function unconfirmedVoices(
  names: NamesData,
  words: Pick<Word, "startMs" | "endMs" | "speaker">[],
  r: Range,
  sensitive: boolean,
): UnconfirmedVoice[] {
  // The export check's per-voice rule (`speakersInRange`): a voice counts by its total time, and then each of its names is listed.
  const persons = personMap(names);
  return unconfirmedSpeakers(speakersInRange(words, names.attributions, r)).map(({ speakerId, resolution }) => {
    const own = resolutionRanges(resolution);
    const ranges =
      own.length > 0 ? unconfirmedRangesIn(names, words, speakerId, resolution, r) : namedPartByPart(names, speakerId) ? remainderSpans(names, words, speakerId, resolutionKey(resolution, speakerId), r) : [];
    return {
      speakerId,
      label: speakerLabel(resolution, persons, speakerId, sensitive),
      atMs: firstSpeakingAs(names, words, r, speakerId, resolution),
      range: ranges[0] ?? null,
      ranges,
      confirm: confirmBody({ speakerId, resolution, ranges }),
    };
  });
}

/** The exact badge copy for a source. */
export function badgeText(source: AttributionSource): string {
  return t(`names.badge.${source}`);
}

/** A voice label as plain text (tooltips, option lists, compact lists): a proposed name carries its badge, "Ana Souza (from caption)". */
export function labelText(label: VoiceLabel): string {
  return label.proposed && label.badge ? `${label.text} (${badgeText(label.badge)})` : label.text;
}

/** The "Names from the … record" line of a matched record (the Câmara link carries no date). */
export function recordMatchedLine(record: { chamber?: "senado" | "camara"; date: string | null }): string {
  return record.chamber === "camara" ? t("names.record.matchedCamara") : t("names.record.matched", { date: record.date ?? "" });
}

/** The date (`DD/MM/YYYY`) of the Senado day a record evidence's `url` points at (`.../discursos/20261021/20261021`); null when it has none. */
function recordEvidenceDate(url: string): string | null {
  const m = /\/discursos\/(\d{4})(\d{2})(\d{2})\//.exec(url);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** One line for the badge tooltip: where the name comes from, and the evidence when there is one. */
export function evidenceLine(a: Attribution): string {
  const e = a.evidence;
  if (e.kind === "record") {
    const date = recordEvidenceDate(e.url);
    const vars = { speech: e.speechId, score: e.score.toFixed(2) };
    if (/^https:\/\/(www\.)?camara\.leg\.br\//.test(e.url)) return t("names.evidenceRecordCamara", vars);
    return date ? t("names.evidenceRecordSenado", { ...vars, date }) : t("names.evidenceRecord", vars);
  }
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
  /**
   * Every range this row's name comes from (one per ranged attribution; a person the record names for several turns of
   * one voice is one row acting on all of them). Empty for a whole-voice name.
   */
  ranges: Range[];
  /** The ranges of this row's name that are still only proposed (a person can have confirmed and proposed turns in one voice); `resolution` is then the unconfirmed one. */
  unconfirmedRanges: Range[];
}

/** One row per (voice, name at that moment): a voice the record named as two people gets two rows. Longest first. */
export function whosWhoRows(names: NamesData, words: Word[]): WhosWhoRow[] {
  const key = resolutionKey;
  const groups = new Map<string, { speakerId: string; resolution: Resolution; ms: number; firstMs: number; k: string; ranges: Map<string, Range>; unconfirmed: Map<string, Range> }>();
  const perVoice = new Map<string, number>();
  let total = 0;
  for (const w of words) {
    const ms = w.endMs - w.startMs;
    if (ms <= 0) continue;
    const resolution = personAt(voiceAtts(names, w.speaker), w.speaker, w.startMs);
    const k = key(resolution, w.speaker);
    const gk = `${w.speaker}\u0000${k}`;
    let cur = groups.get(gk);
    if (cur) cur.ms += ms;
    else {
      cur = { speakerId: w.speaker, resolution, ms, firstMs: w.startMs, k, ranges: new Map(), unconfirmed: new Map() };
      groups.set(gk, cur);
    }
    const mine = resolutionRanges(resolution);
    for (const r of mine) cur.ranges.set(`${r.startMs}-${r.endMs}`, r);
    if (resolution.kind === "named" && !resolution.confirmed) {
      // The row stands for its weakest turn: a person with one confirmed and several proposed turns still needs confirming.
      if (cur.resolution.kind === "named" && cur.resolution.confirmed) cur.resolution = resolution;
      for (const r of mine) cur.unconfirmed.set(`${r.startMs}-${r.endMs}`, r);
    }
    perVoice.set(w.speaker, (perVoice.get(w.speaker) ?? 0) + ms);
    total += ms;
  }
  const turns = turnsOf(words);
  const partByPart = (voice: string) => namedPartByPart(names, voice);
  return [...groups.values()]
    .map((g) => {
      const long = turns.find(
        (tn) =>
          tn.speakerId === g.speakerId && tn.endMs - tn.startMs >= SAMPLE_MIN_MS &&
          key(personAt(voiceAtts(names, g.speakerId), g.speakerId, tn.startMs), g.speakerId) === g.k,
      );
      return {
        speakerId: g.speakerId,
        resolution: g.resolution,
        ms: g.ms,
        share: total > 0 ? g.ms / total : 0,
        sampleStartMs: long?.startMs ?? g.firstMs,
        main: total > 0 && (perVoice.get(g.speakerId) ?? 0) / total >= MIN_SPEAKER_SHARE,
        // In a voice named part by part, the words a whole-voice row names are actionable spans too.
        ranges: partByPart(g.speakerId) ? mergeRanges([...g.ranges.values()], remainderSpans(names, words, g.speakerId, g.k)) : mergeRanges([...g.ranges.values()]),
        unconfirmedRanges: partByPart(g.speakerId)
          ? mergeRanges([...g.unconfirmed.values()], remainderSpans(names, words, g.speakerId, g.k, undefined, true))
          : mergeRanges([...g.unconfirmed.values()]),
      };
    })
    .sort((a, b) => b.ms - a.ms);
}

function resolutionRanges(res: Resolution): Range[] {
  const atts = res.kind === "named" || res.kind === "anonymous" ? [res.attribution] : res.kind === "conflict" ? res.attributions : [];
  return atts.flatMap((a) => (a.startMs !== null && a.endMs !== null ? [{ startMs: a.startMs, endMs: a.endMs }] : []));
}

/** The range a row's name applies to when it comes from a ranged attribution (the first, for a row of several turns); null for a whole-voice row. */
export function rowRange(row: Pick<WhosWhoRow, "resolution">): Range | null {
  const res = row.resolution;
  const a = res.kind === "named" || res.kind === "anonymous" ? res.attribution : res.kind === "conflict" ? res.attributions[0] : undefined;
  return a && a.startMs !== null && a.endMs !== null ? { startMs: a.startMs, endMs: a.endMs } : null;
}

/** All the ranges a row acts on: its `ranges`, or the single `rowRange` for a row built without them. */
export function rowRanges(row: Pick<WhosWhoRow, "resolution"> & { ranges?: Range[] }): Range[] {
  if (row.ranges) return row.ranges;
  const one = rowRange(row);
  return one ? [one] : [];
}

/** The range part of a names API body: `ranges` for several, `startMs`/`endMs` for one, nothing for a whole voice. */
export function rangeFields(ranges: Range[]): Record<string, unknown> {
  if (ranges.length > 1) return { ranges };
  const one = ranges[0];
  return one ? { startMs: one.startMs, endMs: one.endMs } : {};
}

/**
 * The range part of a Change… / No name body: all of the row's `ranges` when it has any (one or several: a part of a
 * part-by-part voice may have just one span and no ranged row of its own), else the single `range`, else the whole voice.
 */
export function scopeFields(ranges: Range[] | undefined, range: Range | undefined): Record<string, unknown> {
  if (ranges && ranges.length > 0) return rangeFields(ranges);
  return range ? { startMs: range.startMs, endMs: range.endMs } : {};
}

/** The body the names API gets for a row's Confirm button; null when the row has no single proposal. A ranged row confirms as a ranged human assignment (all its ranges). */
export function confirmBody(row: Pick<WhosWhoRow, "speakerId" | "resolution"> & { ranges?: Range[]; unconfirmedRanges?: Range[] }): Record<string, unknown> | null {
  const res = row.resolution;
  if (res.kind !== "named" || res.confirmed) return null;
  // Only the turns still proposed: the confirmed ones of the same person stay as they are.
  const ranges = row.unconfirmedRanges && row.unconfirmedRanges.length > 0 ? row.unconfirmedRanges : rowRanges(row);
  return ranges.length > 0
    ? { action: "assign", speakerId: row.speakerId, personId: res.personId, ...rangeFields(ranges) }
    : { action: "confirm", speakerId: row.speakerId };
}

/** The body for a row's "No name" button (all the row's ranges). */
export function anonymousBody(row: WhosWhoRow): Record<string, unknown> {
  return { action: "anonymous", speakerId: row.speakerId, ...rangeFields(rowRanges(row)) };
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
