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
import { importContextNames, lockedParticipants, namedVoices } from "./naming.js";

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
