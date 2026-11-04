import { access, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHAMBERS, PROFILES, formatRecordDate, chamberThresholds, closeMatches, normaliseName, personAt, turnsOf, type Attribution, type ChamberId, type ContextCard, type Fact, type Participant, type Person, type RecordRef, type Resolution, type Word } from "@digestor/core";
import {
  backdateNamesToCard,
  claimRecordFetch,
  createCustomPerson,
  failRecordFetch,
  finishRecordFetch,
  linkRecord,
  releaseRecordFetch,
  waitRecordFetch,
  upsertOfficialPerson,
  findPersonByName,
  getContextCard,
  getPersons,
  getSession,
  getSessionRecord,
  getTranscript,
  listAttributionHistory,
  listAttributions,
  replaceAiAttributions,
  sessionsWithoutNames,
  setStage,
  type Db,
  type LocalStorage,
  type NewAiAttribution,
} from "@digestor/core/server";

import { RecordNotFoundError, RecordNotPublishedError, findConnector, waitingLine, type MemberInfo, type RecordConnector, type RecordSpeech } from "../records/connector.js";
import { readCaptions, captionFramePlan, captionVotes, titleCaseName, type CaptionVote } from "../agents/captions.js";
import { ApiKeyRejectedError, MissingApiKeyError } from "../errors.js";
import { RECORD_RETRY_HOURS } from "../records/retry.js";
import { alignTurns, recordAttributions, similarityMatrix, tieOrder } from "../records/align.js";
import type { PipelineDeps } from "./graph.js";

const NULL_FACT: Fact = { value: null, source: null, evidence: null };
const wholeVoice = (a: Attribution) => a.startMs === null && a.endMs === null;

/** Whole-voice resolution of a speaker, ignoring ranged rows. */
function resolveWhole(atts: Attribution[], speakerId: string) {
  return personAt(atts.filter(wholeVoice), speakerId, 0);
}

/** A record-matched voice: one person's ranged AI rows cover at least this share of the voice's speaking time... */
export const VOICE_COVER_MIN = 0.8;
/** ...and no other person's rows cover more than this share. */
export const VOICE_COVER_OTHER_MAX = 0.1;

/**
 * The one person a voice is, when the ranged rows of its turns say so. Each word of the voice is resolved with
 * `personAt` over every current row (a human's ranged correction included; whole-voice AI proposals are left out,
 * they are not the record's): one person at >= 80% of the voice's speaking time (word durations) and nobody else at
 * > 10% is the voice's person. `confirmed` only when every word in that person's share resolves confirmed. A human
 * "No name" over most of the voice, or a voice split between people, gives none.
 */
export function recordProjection(atts: Attribution[], speakerId: string, words: Word[]): { personId: string; confirmed: boolean; attribution: Attribution } | null {
  const rows = atts.filter((a) => a.speakerId === speakerId && a.supersededAt === null && (a.source === "human" || !wholeVoice(a)));
  if (!rows.some((a) => !wholeVoice(a) && a.source !== "human" && a.status !== "rejected")) return null;
  let total = 0;
  const share = new Map<string, { ms: number; confirmed: boolean; attribution: Attribution }>();
  for (const w of words) {
    if (w.speaker !== speakerId) continue;
    const dur = Math.max(0, w.endMs - w.startMs);
    total += dur;
    const res = personAt(rows, speakerId, w.startMs);
    if (res.kind !== "named") continue;
    const cur = share.get(res.personId) ?? { ms: 0, confirmed: true, attribution: res.attribution };
    cur.ms += dur;
    cur.confirmed &&= res.confirmed;
    share.set(res.personId, cur);
  }
  if (total === 0) return null;
  const ranked = [...share].sort((a, b) => b[1].ms - a[1].ms);
  const top = ranked[0];
  if (!top || top[1].ms / total < VOICE_COVER_MIN) return null;
  if (ranked.slice(1).some(([, v]) => v.ms / total > VOICE_COVER_OTHER_MAX)) return null;
  return { personId: top[0], confirmed: top[1].confirmed, attribution: top[1].attribution };
}

/**
 * Whole-voice resolution for the prompts and the context check: like `resolveWhole`, plus (with the transcript's
 * `words`) the record projection. A human row, or "No name", always wins; a confirmed projection beats a proposal; a
 * proposed one fills a voice that would otherwise be unnamed or in conflict.
 */
function resolveVoice(atts: Attribution[], speakerId: string, words?: Word[]): Resolution {
  const whole = resolveWhole(atts, speakerId);
  if (!words || whole.kind === "anonymous" || (whole.kind === "named" && whole.attribution.source === "human")) return whole;
  const proj = recordProjection(atts, speakerId, words);
  if (!proj) return whole;
  if (whole.kind === "named" && !proj.confirmed) return whole;
  return { kind: "named", personId: proj.personId, confirmed: proj.confirmed, attribution: proj.attribution };
}

/** A human's rejection of this voice/person pair, among `rejected` rows. */
const isRejected = (rejected: Attribution[], r: Pick<NewAiAttribution, "speakerId" | "personId">) =>
  rejected.some((x) => x.speakerId === r.speakerId && x.personId === r.personId);

/** Existing rows as new rows, so a replace keeps them (a rejection the human made stays). */
const keepRows = (rows: Attribution[]): NewAiAttribution[] =>
  rows.map((a) => ({
    speakerId: a.speakerId, startMs: a.startMs, endMs: a.endMs, personId: a.personId, status: a.status,
    confidence: a.confidence, evidence: a.evidence,
  }));

/** The one person among `persons` whose name is a short or full form of `name` (every token of one side is in the other). */
const closeUnique = (name: string, persons: Person[]): Person | null => {
  const close = closeMatches(name, persons);
  return close.length === 1 ? close[0]! : null;
};

/** A leading title of the record's house ("Senadora", "Dra.", "Rep.") is no part of the name an official is known by. */
const stripTitles = new Map<ChamberId, RegExp>();
function stripTitle(name: string, chamber: ChamberId): string {
  let re = stripTitles.get(chamber);
  if (!re) {
    const titles = CHAMBERS[chamber].titles.map((t) => t.replace(/\.$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    re = new RegExp(`^\\s*(?:(?:${titles.join("|")})\\b\\.?\\s+)+`, "i");
    stripTitles.set(chamber, re);
  }
  return name.replace(re, "").trim() || name;
}

const tokenCount = (name: string) => normaliseName(name).split(" ").filter(Boolean).length;

/**
 * The context card's grounded names become `proposed` attributions (transcript or metadata). Never a human row:
 * a human confirms a proposal in Who's who. Voices a human already named (or made anonymous) are left alone.
 * Idempotent: it supersedes only this importer's own rows and reuses persons by name.
 */
export async function importContextNames(db: Db, sessionId: string, card: ContextCard): Promise<void> {
  const current = await listAttributions(db, sessionId);
  const words = (await getTranscript(db, sessionId))?.words;
  // The record's house decides which titles are stripped (record rows without a link row are Brazilian ones from before Plan 4).
  const recordChamber = (await getSessionRecord(db, sessionId))?.ref.chamber ?? "camara";
  const bySource: Record<"transcript" | "metadata", NewAiAttribution[]> = { transcript: [], metadata: [] };
  const repoint = new Map<string, string>(); // voice → person its caption row moves to
  for (const p of card.participants) {
    const name = p.name.value?.trim();
    if (!name || p.name.source === null) continue;
    const res = resolveWhole(current, p.speakerId);
    if (res.kind === "anonymous" || (res.kind === "named" && res.attribution.source === "human")) continue;
    let person: Person | null = null;
    // A voice the record matched: a short or full form of the context name is that official, not a new custom person.
    const proj = words ? recordProjection(current, p.speakerId, words) : null;
    const recordPerson = proj ? closeUnique(stripTitle(name, recordChamber), await getPersons(db, [proj.personId])) : null;
    // It came from the record already: no whole-voice proposal (that row would name the turns the record did not match).
    if (recordPerson) continue;
    const captionRow = current.find((a) => a.source === "caption" && a.status === "proposed" && wholeVoice(a) && a.speakerId === p.speakerId && a.personId);
    const captionPerson = !person && captionRow ? await closeUnique(name, await getPersons(db, [captionRow.personId!])) : null;
    if (captionPerson && tokenCount(captionPerson.displayName) >= tokenCount(name)) person = captionPerson; // the fuller name wins; ties keep the caption's person
    person ??= (await findPersonByName(db, name)) ?? (await createCustomPerson(db, { displayName: name, createdBy: "transcript" }));
    if (captionPerson && person.id !== captionPerson.id) repoint.set(p.speakerId, person.id); // the context name is the fuller one
    const source = p.name.source === "metadata" ? "metadata" : "transcript"; // a human hint or answer is still only a proposal
    bySource[source].push({
      speakerId: p.speakerId, startMs: null, endMs: null, personId: person.id, status: "proposed",
      confidence: source === "metadata" ? 0.6 : 0.7, evidence: { kind: "quote", quote: p.name.evidence ?? name },
    });
  }
  for (const source of ["transcript", "metadata"] as const) {
    // Keep a rejection the human made, and do not propose the rejected person again.
    const rejected = current.filter((a) => a.source === source && a.status === "rejected");
    const rows = [...bySource[source].filter((r) => !isRejected(rejected, r)), ...keepRows(rejected)];
    if (rows.length === 0 && !current.some((a) => a.source === source)) continue;
    await replaceAiAttributions(db, sessionId, source, rows);
  }
  if (repoint.size > 0) {
    // One person for both sources: the caption rows of these voices follow the fuller context name (evidence unchanged).
    const captionRows = current.filter((a) => a.source === "caption");
    const moved = (a: Attribution) => a.status !== "rejected" && wholeVoice(a) && repoint.has(a.speakerId);
    await replaceAiAttributions(db, sessionId, "caption", keepRows(captionRows).map((r, i) => (moved(captionRows[i]!) ? { ...r, personId: repoint.get(r.speakerId)! } : r)));
  }
}

/** Confirmed whole-voice names as human-locked participants for the context prompt. */
export function lockedParticipants(atts: Attribution[], persons: Person[], words?: Word[]): Participant[] {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const out: Participant[] = [];
  for (const id of new Set([...atts.filter(wholeVoice).map((a) => a.speakerId), ...(words ? atts.map((a) => a.speakerId) : [])])) {
    const res = resolveVoice(atts, id, words);
    if (res.kind !== "named" || !res.confirmed) continue;
    const name = byId.get(res.personId)?.displayName;
    if (!name) continue;
    out.push({ speakerId: id, name: { value: name, source: "human", evidence: name }, role: { ...NULL_FACT }, affiliation: { ...NULL_FACT } });
  }
  return out;
}

/** Voices whose whole-voice resolution is a person (confirmed or proposed) or anonymous. */
export function namedVoices(atts: Attribution[], speakerIds: string[], words?: Word[]): Set<string> {
  return new Set(
    speakerIds.filter((id) => {
      const k = resolveVoice(atts, id, words).kind;
      return k === "named" || k === "anonymous";
    }),
  );
}

/** Evidence text of a participant name in a prompt card: the model reads which names are confirmed. */
export const CONFIRMED_NAME = "Confirmed name.";
export const PROBABLE_NAME = "Probably this person: proposed, not confirmed.";

function promptName(res: Resolution, byId: ReadonlyMap<string, Person>, sensitive: boolean): Fact {
  if (res.kind !== "named") return { ...NULL_FACT }; // anonymous, conflict or unnamed: no name
  const name = byId.get(res.personId)?.displayName;
  if (!name) return { ...NULL_FACT };
  if (res.confirmed) return { value: name, source: res.attribution.source === "human" ? "human" : "metadata", evidence: CONFIRMED_NAME };
  if (sensitive) return { ...NULL_FACT }; // sensitive profiles never use an unconfirmed name
  return { value: name, source: res.attribution.source === "metadata" ? "metadata" : "video", evidence: PROBABLE_NAME };
}

/**
 * The card's participants as every prompt sees them (spec §6.1): the name of each voice comes only from its current
 * whole-voice attribution (confirmed as a fact, proposed marked "probably" or dropped when `sensitive`, none for an
 * anonymous, conflicting or unnamed voice), never from the card's own name. Role and affiliation stay from the card.
 */
export function participantsForPrompt(card: ContextCard, atts: Attribution[], persons: Person[], sensitive: boolean, words?: Word[]): Participant[] {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const ids = [...new Set([...card.participants.map((p) => p.speakerId), ...atts.map((a) => a.speakerId)])];
  return ids.map((speakerId) => {
    const base = card.participants.find((p) => p.speakerId === speakerId);
    // A part of the voice a human marked "No name" keeps the whole voice's name out of every prompt, in every profile.
    const partAnonymous = atts.some((a) => a.speakerId === speakerId && a.supersededAt === null && !wholeVoice(a) && a.status === "anonymous");
    return {
      speakerId,
      name: partAnonymous ? { ...NULL_FACT } : promptName(resolveVoice(atts, speakerId, words), byId, sensitive),
      role: base ? { ...base.role } : { ...NULL_FACT },
      affiliation: base ? { ...base.affiliation } : { ...NULL_FACT },
    };
  });
}

/** The context card for a prompt: participants projected from the session's current attributions (sensitivity from the card's profile). */
export async function promptCard(db: Db, sessionId: string, card: ContextCard): Promise<ContextCard> {
  const atts = await listAttributions(db, sessionId);
  const persons = await getPersons(db, [...new Set(atts.flatMap((a) => (a.personId ? [a.personId] : [])))]);
  const sensitive = PROFILES[card.profile.value].sensitive;
  const participants = participantsForPrompt(card, atts, persons, sensitive, (await getTranscript(db, sessionId))?.words);
  const projected = { ...card, participants };
  return sensitive ? hideProtectedNames(projected, card, atts, persons) : projected;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Sensitive profiles: the card's free text (title, summary, setting) was written by the context agent and may still
 * name a voice whose name the prompts withhold (anonymous, unconfirmed, conflicting). Those names (the card's own
 * name for the voice, and any person attributed to it) become "Speaker <id>"; names of voices that stay named do not.
 */
function hideProtectedNames(projected: ContextCard, original: ContextCard, atts: Attribution[], persons: Person[]): ContextCard {
  const byId = new Map(persons.map((p) => [p.id, p.displayName]));
  const keep = new Set<string>();
  const hide = new Map<string, string>(); // lower-case name -> replacement
  for (const p of projected.participants) {
    const own = original.participants.find((o) => o.speakerId === p.speakerId)?.name.value?.trim();
    if (p.name.value !== null) {
      keep.add(p.name.value.toLowerCase());
      continue;
    }
    const names = [own, ...atts.filter((a) => a.speakerId === p.speakerId && a.personId).map((a) => byId.get(a.personId!))];
    for (const n of names) if (n?.trim()) hide.set(n.trim().toLowerCase(), `Speaker ${p.speakerId}`);
  }
  const names = [...hide.keys()].filter((n) => !keep.has(n)).sort((a, b) => b.length - a.length);
  if (names.length === 0) return projected;
  const scrub = (text: string) =>
    names.reduce(
      (t, n) => t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, "giu"), hide.get(n)!),
      text,
    );
  // The prompts render the whole card as JSON, so a fact's evidence quote is scrubbed with its value.
  const fact = (f: Fact): Fact => ({ ...f, value: f.value === null ? null : scrub(f.value), evidence: f.evidence === null ? null : scrub(f.evidence) });
  return {
    ...projected,
    title: fact(projected.title),
    setting: fact(projected.setting),
    summary: scrub(projected.summary),
    participants: projected.participants.map((p) => ({ ...p, role: fact(p.role), affiliation: fact(p.affiliation) })),
  };
}

/**
 * One-off backfill for sessions analysed before speaker names existed (`scripts/import-names.ts`): the context card's
 * names become proposals for every session that has a card and no attribution rows at all. Sessions with any row
 * (current or superseded) are skipped, so it is safe to run again. The imported rows are dated to the card, so the
 * versions already written with those names show no "Names changed" notice. `ids` limits it to those sessions (tests).
 */
export async function importNamesForOldSessions(db: Db, ids?: string[]): Promise<{ imported: string[] }> {
  const imported: string[] = [];
  for (const sessionId of await sessionsWithoutNames(db, ids)) {
    const stored = await getContextCard(db, sessionId);
    if (!stored) continue;
    // One transaction: a human edit made meanwhile can neither be back-dated nor half-see the import.
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await importContextNames(t, sessionId, stored.card);
      // The analysis was written with these very names: date them to the card, so no "Names changed" notice follows.
      await backdateNamesToCard(t, sessionId);
    });
    imported.push(sessionId);
  }
  return { imported };
}

/**
 * The person a caption vote names. An existing person of that name is reused; a short caption ("FLÁVIO") reuses the one
 * person already proposed for the same voice whose name contains it; otherwise a custom person is created.
 * Re-running finds the person it created before, by name.
 */
async function personForVote(db: Db, vote: CaptionVote, current: Attribution[]): Promise<Person> {
  const name = titleCaseName(vote.name);
  const byName = await findPersonByName(db, name);
  if (byName) return byName;
  const ids = new Set(
    current
      .filter((a) => a.speakerId === vote.speakerId && wholeVoice(a) && (a.source === "transcript" || a.source === "metadata") && a.personId)
      .map((a) => a.personId!),
  );
  const close = closeUnique(name, await getPersons(db, [...ids]));
  if (close) return close;
  return createCustomPerson(db, { displayName: name, createdBy: "caption" });
}

/**
 * Runs after the context check, once the profile is final (owner decision 2026-11-03): reads the lower-third captions
 * of the original video and proposes names (source `caption`, status `proposed`, never confirmed). Skipped for
 * sensitive profiles (`trial`: no frame of a witness is ever sent, even when the journalist corrected the profile at
 * the check), audio-only sessions and once the video is gone. Safe to run twice: it supersedes only its
 * own rows (keeping a person a human rejected) and reuses persons by name. Only a missing API key fails the session
 * (Ruling R8); any other failure is logged and the pipeline goes on without caption names.
 */
export const nameSpeakersNode =
  (deps: PipelineDeps) =>
  async (s: { sessionId: string }): Promise<Record<string, never>> => {
    const { db, storage } = deps;
    await setStage(db, s.sessionId, "naming_speakers", 60);
    try {
      const session = await getSession(db, s.sessionId);
      if (!session || !session.hasVideo || session.videoDeletedAt || !session.originalKey) return {};
      const original = storage.resolve(session.originalKey);
      if (!(await access(original).then(() => true, () => false))) return {};
      const transcript = await getTranscript(db, s.sessionId);
      if (!transcript) return {};
      const stored = await getContextCard(db, s.sessionId);
      const profile = stored?.card.profile.value ?? session.profile;
      if (profile && profile in PROFILES && PROFILES[profile as keyof typeof PROFILES].sensitive) return {};
      const planned = captionFramePlan(transcript.words).length;
      const reads = await readCaptions({ llm: deps.llm, storage, media: deps.media }, s.sessionId, session.originalKey, transcript.words);
      try {
        if (planned > 0 && reads.length === 0) return {}; // nothing could be read: keep what an earlier run proposed
        await writeCaptionRows(deps, s.sessionId, reads);
      } finally {
        await pruneFrames(db, storage, s.sessionId);
      }
    } catch (err) {
      if (err instanceof MissingApiKeyError) throw err; // deterministic: fail the session (Ruling R8)
      console.error(`name_speakers: could not read captions for session ${s.sessionId}; continuing without caption names`, err);
    }
    return {};
  };

/** Votes → persons → `caption` rows (see `nameSpeakersNode`). */
async function writeCaptionRows(deps: PipelineDeps, sessionId: string, reads: Awaited<ReturnType<typeof readCaptions>>): Promise<void> {
  const { db } = deps;
  const current = await listAttributions(db, sessionId);
  const rejected = current.filter((a) => a.source === "caption" && a.status === "rejected");
  const rows: NewAiAttribution[] = [];
  for (const vote of captionVotes(reads)) {
    const res = resolveWhole(current, vote.speakerId);
    if (res.kind === "anonymous" || (res.kind === "named" && res.attribution.source === "human")) continue;
    const person = await personForVote(db, vote, current);
    if (isRejected(rejected, { speakerId: vote.speakerId, personId: person.id })) continue;
    rows.push({
      speakerId: vote.speakerId, startMs: null, endMs: null, personId: person.id, status: "proposed",
      confidence: vote.agreeing / vote.total, evidence: { kind: "caption", frameKey: vote.frameKey, text: vote.text, atMs: vote.atMs },
    });
  }
  if (rows.length === 0 && !current.some((a) => a.source === "caption")) return;
  await replaceAiAttributions(db, sessionId, "caption", [...rows, ...keepRows(rejected)]);
}

/** Caption frames are evidence: keep those a caption row (current, rejected or superseded) points to, delete the rest. */
async function pruneFrames(db: Db, storage: Pick<LocalStorage, "key" | "resolve">, sessionId: string): Promise<void> {
  try {
    const dir = path.dirname(storage.resolve(storage.key(sessionId, "names/x")));
    const keep = new Set(
      (await listAttributionHistory(db, sessionId)).flatMap((a) => (a.source === "caption" && a.evidence.kind === "caption" ? [a.evidence.frameKey] : [])),
    );
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (!/\.jpg$/.test(file)) continue; // only caption frames and their `.tmp-*.jpg` leftovers; e.g. record.json stays
      if (!keep.has(storage.key(sessionId, `names/${file}`))) await rm(path.join(dir, file), { force: true });
    }
  } catch (err) {
    console.error(`name_speakers: could not clean up caption frames of session ${sessionId}`, err);
  }
}

export const RECORD_NOT_FOUND = "The Senado has no speeches for that date.";
export const RECORD_ALL_REJECTED = "No speech in the record was kept for this video.";
/** `date` is the record's day as the connector returned it (`YYYY-MM-DD`; a Câmara link carries no date of its own). */
export const recordNoMatch = (ref: RecordRef, date: string) =>
  `None of the speeches in the ${CHAMBERS[ref.chamber].shortName} record of ${formatRecordDate(ref.chamber, date)} match this video. ${"eventId" in ref ? "Check the link." : "Check the date."}`;

/** A transient failure of a claimed run, carrying the ref it claimed so the caller fails only that claim. */
export class RecordStepError extends Error {
  constructor(readonly original: unknown, readonly ref: RecordRef) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "RecordStepError";
  }
}
/** The failure line of a record fetch; neutral when the ref is unknown (an error that carries no claim). */
export const recordFetchFailed = (ref?: RecordRef) =>
  `The ${ref ? CHAMBERS[ref.chamber].shortName : "official"} record couldn't be fetched. Please try again.`;

export type RecordStepDeps = Pick<PipelineDeps, "db" | "storage"> & {
  fetch?: typeof fetch;
  /** Test injection: used before the registry. */
  connectors?: Partial<Record<ChamberId, RecordConnector | null>>;
};

/**
 * Matches the session's linked official record against its transcript (the `record` source). One code path for the
 * graph node (`match_record`) and the `session.names` job. Claims the row (`pending` → `running`; with `retrying` a
 * `running` row is taken over, since a retry finds its own claim), fetches the speeches, aligns them to the voice turns,
 * upserts the senators or deputies and replaces only the `record` rows (human rows are never touched and always win). Stores the
 * raw payload at `<sessionId>/names/record.json`, then marks the row `matched`.
 * - no speeches for the date or event: the row is `failed` with a friendly line and it returns (a retry can't help);
 * - any other error (5xx, network): thrown, the row stays `running` so the caller decides (the job retries, then fails it).
 * Without a linked record, with a row that isn't claimable, or before the transcript exists, it does nothing.
 */
export async function runRecordStep(deps: RecordStepDeps, sessionId: string, opts: { retrying?: boolean } = {}): Promise<void> {
  const { db } = deps;
  const f = deps.fetch ?? fetch;
  const record = await claimRecordFetch(db, sessionId);
  if (!record) {
    if (!opts.retrying) return;
    const current = await getSessionRecord(db, sessionId);
    if (current?.status !== "running") return;
    return runClaimedOrThrow(deps, sessionId, current.ref, f, { linkedAt: current.linkedAt });
  }
  return runClaimedOrThrow(deps, sessionId, record.ref, f, { linkedAt: record.linkedAt });
}

/** `runClaimed`, with an unexpected (transient) error wrapped so the caller knows which claim it belongs to. */
async function runClaimedOrThrow(deps: RecordStepDeps, sessionId: string, ref: RecordRef, f: typeof fetch, claimed: { linkedAt: Date }): Promise<void> {
  try {
    await runClaimed(deps, sessionId, ref, f, claimed);
  } catch (err) {
    throw new RecordStepError(err, ref);
  }
}

async function runClaimed(deps: RecordStepDeps, sessionId: string, ref: RecordRef, f: typeof fetch, claimed: { linkedAt: Date }): Promise<void> {
  const { db, storage } = deps;
  const transcript = await getTranscript(db, sessionId);
  if (!transcript) {
    await linkRecord(db, sessionId, ref); // nothing to match yet: back to `pending` for the graph step
    return;
  }
  const connector = deps.connectors && ref.chamber in deps.connectors ? deps.connectors[ref.chamber] : findConnector(ref.chamber);
  if (!connector) {
    // A house without a connector yet: nothing a retry could change.
    await failRecordFetch(db, sessionId, `The ${CHAMBERS[ref.chamber].shortName} record can't be read yet.`, ref);
    return;
  }
  let speeches: RecordSpeech[];
  let eventDate: string;
  let members: Record<string, MemberInfo>;
  let recordUrl: string | undefined;
  try {
    ({ speeches, date: eventDate, members, url: recordUrl } = await connector.fetchRecord(ref, f, { now: new Date(), linkedAt: claimed.linkedAt }));
  } catch (err) {
    if (err instanceof RecordNotFoundError || err instanceof MissingApiKeyError || err instanceof ApiKeyRejectedError) {
      // Deterministic: the record has nothing for it, or the server lacks the house's key ("<VAR> is not set on the server."). No retry.
      await failRecordFetch(db, sessionId, err.message, ref);
      return;
    }
    if (err instanceof RecordNotPublishedError) {
      // Not out yet: wait and look again (records.retry); a re-link meanwhile keeps its own row.
      await waitRecordFetch(db, sessionId, ref, new Date(Date.now() + RECORD_RETRY_HOURS * 3_600_000), waitingLine(ref));
      return;
    }
    throw err;
  }
  const fetchedAt = new Date().toISOString();
  const turns = turnsOf(transcript.words);
  // Speeches sharing a stamp (the Câmara's 4-minute blocks) have no known order: order each run by best-matching turn.
  const sim = similarityMatrix(turns, speeches, connector);
  const perm = tieOrder(sim, speeches);
  speeches = perm.map((j) => speeches[j]!);
  const thresholds = chamberThresholds(ref.chamber);
  const matches = alignTurns(sim.map((row) => perm.map((j) => row[j]!))).filter((m) => m.score >= thresholds.propose);
  const bySpeech = new Map(speeches.map((sp) => [sp.id, sp]));

  // One person per matched member (the connector read their fields once per run); a speech with no official id names no one.
  const personIds = new Map<string, string>();
  for (const m of matches) {
    const speech = speeches[m.speech]!;
    if (speech.officialId === null || personIds.has(speech.officialId)) continue;
    const member = members[speech.officialId];
    const person = await upsertOfficialPerson(db, {
      idSystem: CHAMBERS[ref.chamber].idSystem,
      officialId: speech.officialId,
      displayName: member?.displayName ?? titleCaseName(speech.name),
      fullName: member?.fullName ?? undefined,
      party: member?.party ?? speech.party ?? undefined,
      state: member?.state ?? speech.state ?? undefined,
      photoUrl: member?.photoUrl ? httpsPhoto(member.photoUrl) : undefined,
    });
    personIds.set(speech.officialId, person.id);
  }

  const current = await listAttributions(db, sessionId);
  const rejected = current.filter((a) => a.source === "record" && a.status === "rejected");
  const matched = recordAttributions(turns, speeches, matches, (officialId) => personIds.get(officialId)!, { url: recordUrl ?? ref.url, fetchedAt, chamber: ref.chamber, date: eventDate }, thresholds);
  const fresh = matched.filter((r) => !isRejected(rejected, r));
  // A re-link to another record meanwhile makes this run stale: write nothing (the new run owns the rows).
  const now = await getSessionRecord(db, sessionId);
  if (!now || now.status !== "running" || !sameRef(now.ref, ref)) {
    console.log(`names: session ${sessionId}: the linked record changed during the run; dropping its result`);
    return;
  }
  if (fresh.length === 0) {
    // Nothing matched: no names (an earlier run's rows go, rejections stay) and no "matched" status.
    if (current.some((a) => a.source === "record")) await replaceAiAttributions(db, sessionId, "record", keepRows(rejected));
    await failRecordFetch(db, sessionId, matched.length > 0 ? RECORD_ALL_REJECTED : recordNoMatch(ref, eventDate), ref);
    return;
  }
  if (fresh.length > 0 && fresh.every((r) => bySpeech.get((r.evidence as { speechId: string }).speechId)?.textSource === "summary")) {
    console.log(`names: session ${sessionId}: the record gave only summaries for the matched speeches; names are proposals only`);
  }
  if (fresh.length > 0 || current.some((a) => a.source === "record")) {
    await replaceAiAttributions(db, sessionId, "record", [...fresh, ...keepRows(rejected)]);
  }
  const rawKey = storage.key(sessionId, "names/record.json");
  await writeFile(storage.resolve(rawKey), JSON.stringify({ ref, fetchedAt, speeches }));
  await finishRecordFetch(db, sessionId, { rawKey, ref });
}

const sameRef = (a: RecordRef, b: RecordRef) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));

/** The Senado serves photos as `http://`; the same path works over https (a redirect to the image), so store that. */
const httpsPhoto = (url: string) => url.replace(/^http:\/\//i, "https://");

/**
 * The graph's record step (before the context check, so the pause already shows official names): a no-op unless a record
 * is linked. It never fails the session: any error is logged. A transient one (5xx, network) hands the row back to
 * `pending` and sends `session.names` (the job retries it with backoff and fails the row on its last attempt); when
 * that send is impossible or fails, the row is marked failed.
 */
export const matchRecordNode =
  (deps: PipelineDeps) =>
  async (s: { sessionId: string }): Promise<Record<string, never>> => {
    try {
      await runRecordStep(deps, s.sessionId, { retrying: true }); // a crashed earlier attempt may have left the row running
    } catch (err) {
      console.error(`match_record: could not match the record of session ${s.sessionId}; continuing without it`, err);
      const ref = err instanceof RecordStepError ? err.ref : undefined;
      const failed = () => failRecordFetch(deps.db, s.sessionId, recordFetchFailed(ref), ref).catch(() => {});
      if (!deps.enqueueNames || !ref) {
        await failed();
      } else {
        // Release first, then send: a job that ran before the release would find a running row and do nothing.
        const released = await releaseRecordFetch(deps.db, s.sessionId, ref).catch(() => false);
        if (released) {
          try {
            await deps.enqueueNames(s.sessionId);
          } catch (sendErr) {
            console.error(`match_record: could not queue session.names for ${s.sessionId}`, sendErr);
            if (await claimRecordFetch(deps.db, s.sessionId).catch(() => null)) await failed(); // take it back, then fail it
          }
        }
      }
    }
    return {};
  };
