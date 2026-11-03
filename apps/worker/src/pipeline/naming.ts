import { access } from "node:fs/promises";
import { PROFILES, closeMatches, personAt, type Attribution, type ContextCard, type Fact, type Participant, type Person, type Resolution } from "@digestor/core";
import {
  backdateNamesToCard,
  createCustomPerson,
  findPersonByName,
  getContextCard,
  getPersons,
  getSession,
  getTranscript,
  listAttributions,
  replaceAiAttributions,
  sessionsWithoutNames,
  setStage,
  type Db,
  type NewAiAttribution,
} from "@digestor/core/server";

import { readCaptions, captionVotes, type CaptionVote } from "../agents/captions.js";
import { MissingApiKeyError } from "../errors.js";
import type { PipelineDeps } from "./graph.js";

const NULL_FACT: Fact = { value: null, source: null, evidence: null };
const wholeVoice = (a: Attribution) => a.startMs === null && a.endMs === null;

/** Whole-voice resolution of a speaker, ignoring ranged rows. */
function resolveWhole(atts: Attribution[], speakerId: string) {
  return personAt(atts.filter(wholeVoice), speakerId, 0);
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

/**
 * The context card's grounded names become `proposed` attributions (transcript or metadata). Never a human row:
 * a human confirms a proposal in Who's who. Voices a human already named (or made anonymous) are left alone.
 * Idempotent: it supersedes only this importer's own rows and reuses persons by name.
 */
export async function importContextNames(db: Db, sessionId: string, card: ContextCard): Promise<void> {
  const current = await listAttributions(db, sessionId);
  const bySource: Record<"transcript" | "metadata", NewAiAttribution[]> = { transcript: [], metadata: [] };
  for (const p of card.participants) {
    const name = p.name.value?.trim();
    if (!name || p.name.source === null) continue;
    const res = resolveWhole(current, p.speakerId);
    if (res.kind === "anonymous" || (res.kind === "named" && res.attribution.source === "human")) continue;
    const person = (await findPersonByName(db, name)) ?? (await createCustomPerson(db, { displayName: name, createdBy: "transcript" }));
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
}

/** Confirmed whole-voice names as human-locked participants for the context prompt. */
export function lockedParticipants(atts: Attribution[], persons: Person[]): Participant[] {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const out: Participant[] = [];
  for (const id of new Set(atts.filter(wholeVoice).map((a) => a.speakerId))) {
    const res = resolveWhole(atts, id);
    if (res.kind !== "named" || !res.confirmed) continue;
    const name = byId.get(res.personId)?.displayName;
    if (!name) continue;
    out.push({ speakerId: id, name: { value: name, source: "human", evidence: name }, role: { ...NULL_FACT }, affiliation: { ...NULL_FACT } });
  }
  return out;
}

/** Voices whose whole-voice resolution is a person (confirmed or proposed) or anonymous. */
export function namedVoices(atts: Attribution[], speakerIds: string[]): Set<string> {
  return new Set(
    speakerIds.filter((id) => {
      const k = resolveWhole(atts, id).kind;
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
export function participantsForPrompt(card: ContextCard, atts: Attribution[], persons: Person[], sensitive: boolean): Participant[] {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const ids = [...new Set([...card.participants.map((p) => p.speakerId), ...atts.map((a) => a.speakerId)])];
  return ids.map((speakerId) => {
    const base = card.participants.find((p) => p.speakerId === speakerId);
    // A part of the voice a human marked "No name" keeps the whole voice's name out of every prompt, in every profile.
    const partAnonymous = atts.some((a) => a.speakerId === speakerId && a.supersededAt === null && !wholeVoice(a) && a.status === "anonymous");
    return {
      speakerId,
      name: partAnonymous ? { ...NULL_FACT } : promptName(resolveWhole(atts, speakerId), byId, sensitive),
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
  const participants = participantsForPrompt(card, atts, persons, sensitive);
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
  const byName = await findPersonByName(db, vote.name);
  if (byName) return byName;
  const ids = new Set(
    current
      .filter((a) => a.speakerId === vote.speakerId && wholeVoice(a) && (a.source === "transcript" || a.source === "metadata") && a.personId)
      .map((a) => a.personId!),
  );
  const close = closeMatches(vote.name, await getPersons(db, [...ids]));
  if (close.length === 1) return close[0]!;
  return createCustomPerson(db, { displayName: vote.name, createdBy: "caption" });
}

/**
 * Reads the lower-third captions of the original video and proposes names (source `caption`, status `proposed`, never
 * confirmed). Skipped for audio-only sessions and once the video is gone. Safe to run twice: it supersedes only its
 * own rows (keeping a person a human rejected) and reuses persons by name. Only a missing API key fails the session
 * (Ruling R8); any other failure is logged and the pipeline goes on without caption names.
 */
export const nameSpeakersNode =
  (deps: PipelineDeps) =>
  async (s: { sessionId: string }): Promise<Record<string, never>> => {
    const { db, storage } = deps;
    await setStage(db, s.sessionId, "naming_speakers", 50);
    try {
      const session = await getSession(db, s.sessionId);
      if (!session || !session.hasVideo || session.videoDeletedAt || !session.originalKey) return {};
      const original = storage.resolve(session.originalKey);
      if (!(await access(original).then(() => true, () => false))) return {};
      const transcript = await getTranscript(db, s.sessionId);
      if (!transcript) return {};
      const reads = await readCaptions({ llm: deps.llm, storage, media: deps.media }, s.sessionId, session.originalKey, transcript.words);
      const current = await listAttributions(db, s.sessionId);
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
      if (rows.length === 0 && !current.some((a) => a.source === "caption")) return {};
      await replaceAiAttributions(db, s.sessionId, "caption", [...rows, ...keepRows(rejected)]);
    } catch (err) {
      if (err instanceof MissingApiKeyError) throw err; // deterministic: fail the session (Ruling R8)
      console.error(`name_speakers: could not read captions for session ${s.sessionId}; continuing without caption names`, err);
    }
    return {};
  };
