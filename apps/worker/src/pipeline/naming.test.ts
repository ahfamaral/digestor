import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Attribution, ContextCard, Fact, Person } from "@digestor/core";
import {
  createCustomPerson,
  createDb,
  createSession,
  listAttributions,
  setHumanAttribution,
  getPersons,
  type Db,
} from "@digestor/core/server";
import {
  CONFIRMED_NAME, PROBABLE_NAME, importContextNames, lockedParticipants, namedVoices, participantsForPrompt,
} from "./naming.js";

const none: Fact = { value: null, source: null, evidence: null };
const fact = (value: string, source: Fact["source"], evidence: string): Fact => ({ value, source, evidence });
const cardWith = (names: Record<string, Fact>): ContextCard => ({
  language: none,
  profile: { value: "interview", confidence: 0.9, evidence: "x" },
  title: none,
  summary: "s",
  setting: none,
  dateOrYear: none,
  participants: Object.entries(names).map(([speakerId, name]) => ({ speakerId, name, role: none, affiliation: none })),
  sufficient: false,
  openQuestions: [],
});

let db: Db;
let close: () => Promise<void>;
beforeAll(() => ({ db, close } = createDb(process.env.TEST_DATABASE_URL!)));
afterAll(() => close());

const newSession = async () => (await createSession(db, { title: "t", source: "upload" })).id;

describe("importContextNames", () => {
  it("proposes grounded names with their source", async () => {
    const id = await newSession();
    await importContextNames(
      db,
      id,
      cardWith({
        B: fact("Flávio Bolsonaro", "video", "Flávio Bolsonaro fala"),
        C: fact("Ana Meta", "metadata", "Ana Meta"),
        D: fact("Rui Hint", "human", "o Rui Hint"),
        E: none,
      }),
    );
    const atts = await listAttributions(db, id);
    expect(atts.map((a) => [a.speakerId, a.source, a.status]).sort()).toEqual([
      ["B", "transcript", "proposed"],
      ["C", "metadata", "proposed"],
      ["D", "transcript", "proposed"],
    ]);
    const b = atts.find((a) => a.speakerId === "B")!;
    expect(b).toMatchObject({ startMs: null, endMs: null, evidence: { kind: "quote", quote: "Flávio Bolsonaro fala" } });
    const [p] = await getPersons(db, [b.personId!]);
    expect(p).toMatchObject({ displayName: "Flávio Bolsonaro", kind: "custom" });
    expect(atts.find((a) => a.speakerId === "D")!.evidence).toEqual({ kind: "quote", quote: "o Rui Hint" });
  });

  it("a second call reuses the person and does not duplicate rows", async () => {
    const id = await newSession();
    const card = cardWith({ B: fact("Zélia Repetida", "video", "Zélia Repetida") });
    await importContextNames(db, id, card);
    const first = await listAttributions(db, id);
    await importContextNames(db, id, card);
    const second = await listAttributions(db, id);
    expect(second).toHaveLength(1);
    expect(second[0]!.personId).toBe(first[0]!.personId);
  });

  it("never writes human rows and leaves a voice a human already named alone", async () => {
    const id = await newSession();
    const p = await createCustomPerson(db, { displayName: "Dona Humana", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId: id, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    await importContextNames(db, id, cardWith({ A: fact("Dona Humana", "human", "Dona Humana"), B: fact("Outro Nome", "video", "Outro Nome") }));
    const atts = await listAttributions(db, id);
    expect(atts.filter((a) => a.source === "human")).toHaveLength(1);
    expect(atts.filter((a) => a.speakerId === "A")).toHaveLength(1);
  });
});

const person = (id: string, displayName: string): Person => ({
  id, displayName, fullName: null, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
});
const att = (o: Partial<Attribution>): Attribution => ({
  id: "x", sessionId: "s", speakerId: "A", startMs: null, endMs: null, personId: "p1", source: "human", status: "confirmed",
  confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(), supersededAt: null, ...o,
});

describe("lockedParticipants and namedVoices", () => {
  it("confirmed whole-voice names become human facts; proposals do not", () => {
    const atts = [
      att({ speakerId: "A", personId: "p1" }),
      att({ speakerId: "B", personId: "p2", source: "transcript", status: "proposed" }),
    ];
    const locked = lockedParticipants(atts, [person("p1", "Maria Silva"), person("p2", "Outro")]);
    expect(locked).toEqual([
      {
        speakerId: "A",
        name: { value: "Maria Silva", source: "human", evidence: "Maria Silva" },
        role: none,
        affiliation: none,
      },
    ]);
  });
  it("named or anonymous whole voices count; ranged rows do not", () => {
    const atts = [
      att({ speakerId: "A" }),
      att({ speakerId: "B", personId: null, status: "anonymous" }),
      att({ speakerId: "C", startMs: 0, endMs: 5000 }),
    ];
    expect([...namedVoices(atts, ["A", "B", "C", "D"])].sort()).toEqual(["A", "B"]);
  });
});

describe("participantsForPrompt", () => {
  const persons = [person("p1", "Maria Silva"), person("p2", "Nome Proposto"), person("p3", "Joana Humana")];
  const role = fact("judge", "video", "the judge");
  const card: ContextCard = {
    ...cardWith({ A: fact("Nome Antigo", "video", "Nome Antigo"), B: none, C: fact("Nome Antigo C", "human", "x"), D: fact("Pessoa Protegida", "video", "x") }),
  };
  card.participants[0] = { ...card.participants[0]!, role };

  it("names come only from the attributions: confirmed as facts, proposed as probably, none otherwise", () => {
    const atts = [
      att({ speakerId: "A", personId: "p1" }), // human rename beats the card's AI name
      att({ speakerId: "B", personId: "p2", source: "transcript", status: "proposed" }),
      att({ speakerId: "D", personId: null, status: "anonymous" }),
      att({ speakerId: "E", personId: "p3" }), // a voice the card does not list
    ];
    const out = participantsForPrompt(card, atts, persons, false);
    const byId = Object.fromEntries(out.map((p) => [p.speakerId, p]));
    expect(byId.A).toEqual({ speakerId: "A", name: { value: "Maria Silva", source: "human", evidence: CONFIRMED_NAME }, role, affiliation: none });
    expect(byId.B!.name).toEqual({ value: "Nome Proposto", source: "video", evidence: PROBABLE_NAME });
    expect(byId.C!.name).toEqual(none); // unnamed: never the card's own name, even a human-sourced one
    expect(byId.D!.name).toEqual(none); // "No name"
    expect(byId.E!.name).toMatchObject({ value: "Joana Humana", evidence: CONFIRMED_NAME });
    expect(JSON.stringify(out)).not.toMatch(/Nome Antigo|Pessoa Protegida/);
  });

  it("a sensitive profile drops proposed names; a conflict has no name; ranged rows are ignored", () => {
    const atts = [
      att({ speakerId: "A", personId: "p2", source: "caption", status: "proposed" }),
      att({ speakerId: "B", personId: "p1", source: "transcript", status: "proposed" }),
      att({ speakerId: "B", personId: "p2", source: "caption", status: "proposed" }),
      att({ speakerId: "C", personId: "p3", startMs: 0, endMs: 5000 }),
    ];
    const out = participantsForPrompt(card, atts, persons, true);
    expect(out.map((p) => [p.speakerId, p.name.value])).toEqual([["A", null], ["B", null], ["C", null], ["D", null]]);
    expect(participantsForPrompt(card, atts, persons, false).find((p) => p.speakerId === "A")!.name.value).toBe("Nome Proposto");
  });
});
