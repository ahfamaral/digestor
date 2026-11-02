import { PROFILES, personAt, type Attribution, type ContextCard, type Fact, type Participant, type Person, type Resolution } from "@digestor/core";
import {
  createCustomPerson,
  findPersonByName,
  getPersons,
  listAttributions,
  replaceAiAttributions,
  type Db,
  type NewAiAttribution,
} from "@digestor/core/server";

const NULL_FACT: Fact = { value: null, source: null, evidence: null };
const wholeVoice = (a: Attribution) => a.startMs === null && a.endMs === null;

/** Whole-voice resolution of a speaker, ignoring ranged rows. */
function resolveWhole(atts: Attribution[], speakerId: string) {
  return personAt(atts.filter(wholeVoice), speakerId, 0);
}

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
    const rows = [
      ...bySource[source].filter((r) => !rejected.some((x) => x.speakerId === r.speakerId && x.personId === r.personId)),
      ...rejected.map((a) => ({
        speakerId: a.speakerId, startMs: a.startMs, endMs: a.endMs, personId: a.personId, status: a.status,
        confidence: a.confidence, evidence: a.evidence,
      })),
    ];
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
    return {
      speakerId,
      name: promptName(resolveWhole(atts, speakerId), byId, sensitive),
      role: base ? { ...base.role } : { ...NULL_FACT },
      affiliation: base ? { ...base.affiliation } : { ...NULL_FACT },
    };
  });
}

/** The context card for a prompt: participants projected from the session's current attributions (sensitivity from the card's profile). */
export async function promptCard(db: Db, sessionId: string, card: ContextCard): Promise<ContextCard> {
  const atts = await listAttributions(db, sessionId);
  const persons = await getPersons(db, [...new Set(atts.flatMap((a) => (a.personId ? [a.personId] : [])))]);
  return { ...card, participants: participantsForPrompt(card, atts, persons, PROFILES[card.profile.value].sensitive) };
}
