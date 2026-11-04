import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { personAt, type Attribution, type ContextCard, type Fact, type Person, type Word } from "@digestor/core";
import {
  backdateNamesToCard,
  createCustomPerson,
  createDb,
  createSession,
  listAttributions,
  setHumanAttribution,
  getPersons,
  findPersonByName,
  replaceAiAttributions,
  saveTranscript,
  upsertOfficialPerson,
  type Db,
} from "@digestor/core/server";
import { getAnalysisVersion, listAttributionHistory, saveContextCard, startAnalysisVersion } from "@digestor/core/server";
import { namesChangedSince } from "@digestor/core";
import { sql } from "drizzle-orm";
import {
  CONFIRMED_NAME, PROBABLE_NAME, importContextNames, importNamesForOldSessions, lockedParticipants, namedVoices, participantsForPrompt, promptCard, recordProjection,
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

describe("participantsForPrompt, ranged No name", () => {
  const persons = [person("p1", "Xavier Nome")];
  const card = cardWith({ B: none });
  const whole = att({ speakerId: "B", personId: "p1" });
  const nameOfB = (atts: Attribution[], sensitive = false) =>
    participantsForPrompt(card, atts, persons, sensitive).find((p) => p.speakerId === "B")!.name;

  it("a ranged No name keeps the voice's name out of prompts", () => {
    const ranged = att({ speakerId: "B", personId: null, status: "anonymous", startMs: 120_000, endMs: 180_000 });
    expect(nameOfB([whole])).toMatchObject({ value: "Xavier Nome" });
    expect(nameOfB([whole, ranged])).toEqual(none);
    expect(nameOfB([whole, ranged], true)).toEqual(none);
    expect(nameOfB([whole, { ...ranged, supersededAt: new Date() }])).toMatchObject({ value: "Xavier Nome" });
  });
});

describe("promptCard in a sensitive profile", () => {
  const trialCard = (): ContextCard => ({
    ...cardWith({ A: fact("Maria Confirmada", "video", "x"), B: fact("Rui Proposto", "video", "x") }),
    profile: { value: "trial", confidence: 0.9, evidence: "x" },
    title: fact("Julgamento de Rui Proposto", "video", "x"),
    summary: "Maria Confirmada ouve rui proposto, e depois Ana Sugerida.",
    setting: fact("Sala 3", "video", "x"),
  });
  const setup = async (profile: "trial" | "interview") => {
    const id = await newSession();
    const confirmed = await createCustomPerson(db, { displayName: "Maria Confirmada", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId: id, speakerId: "A", startMs: null, endMs: null, personId: confirmed.id, ownerId: "owner" });
    const card = { ...trialCard(), profile: { value: profile, confidence: 0.9, evidence: "x" } };
    await importContextNames(db, id, { ...card, participants: [...card.participants, { speakerId: "C", name: fact("Ana Sugerida", "video", "x"), role: none, affiliation: none }] });
    return { id, card };
  };

  it("a sensitive card hides an unconfirmed name in its free text", async () => {
    const { id, card } = await setup("trial");
    const out = await promptCard(db, id, card);
    expect(out.title.value).toBe("Julgamento de Speaker B");
    expect(out.summary).toBe("Maria Confirmada ouve Speaker B, e depois Speaker C.");
    expect(out.setting.value).toBe("Sala 3");
  });
  it("a sensitive card also scrubs the evidence quotes of its free-text facts", async () => {
    const { id, card } = await setup("trial");
    const out = await promptCard(db, id, { ...card, title: fact("Julgamento", "video", "ouvimos Rui Proposto") });
    expect(out.title).toEqual(fact("Julgamento", "video", "ouvimos Speaker B"));
  });
  it("a non-sensitive card keeps its free text", async () => {
    const { id, card } = await setup("interview");
    const out = await promptCard(db, id, card);
    expect(out.title.value).toBe("Julgamento de Rui Proposto");
    expect(out.summary).toBe(card.summary);
  });
});

describe("importNamesForOldSessions", () => {
  it("the backfill leaves a human row's date alone", async () => {
    // A session that already has a human row is skipped by the import, so a concurrent edit cannot be staged: the
    // import runs through importNamesForOldSessions (transaction path), then a human row is added and the back-date
    // is called again, as a later run would.
    const id = await newSession();
    await saveContextCard(db, id, cardWith({ A: fact("Velho Nome", "video", "Velho Nome") }), 1);
    await db.execute(sql`update context_cards set updated_at = '2026-01-01T00:00:00Z' where session_id = ${id}`);
    const before = Date.now();
    expect(await importNamesForOldSessions(db, [id])).toEqual({ imported: [id] });
    const p = await createCustomPerson(db, { displayName: "Edição Humana", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId: id, speakerId: "B", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    await backdateNamesToCard(db, id);
    const atts = await listAttributions(db, id);
    expect(atts.find((a) => a.source === "transcript")!.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(atts.find((a) => a.source === "human")!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
  it("imports the card's names for sessions with a card and no attributions; skips the rest; idempotent", async () => {
    const old = await newSession();
    await saveContextCard(db, old, cardWith({ A: fact("Velho Nome", "video", "Velho Nome"), B: fact("Dita Humana", "human", "Dita Humana") }), 1);
    const named = await newSession();
    await saveContextCard(db, named, cardWith({ A: fact("Ignorado", "video", "Ignorado") }), 1);
    const p = await createCustomPerson(db, { displayName: "Já Nomeada", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId: named, speakerId: "B", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    const noCard = await newSession();
    const v = await startAnalysisVersion(db, old, { profile: "interview", reason: "initial", models: {}, promptVersions: {} });
    const namesAt = (await getAnalysisVersion(db, v.id))!.namesAt;

    const first = await importNamesForOldSessions(db, [old, named, noCard]);
    expect(first).toEqual({ imported: [old] });
    const atts = await listAttributions(db, old);
    expect(atts.map((a) => [a.speakerId, a.source, a.status]).sort()).toEqual([
      ["A", "transcript", "proposed"],
      ["B", "transcript", "proposed"], // a human-sourced card fact stays a proposal
    ]);
    expect((await listAttributions(db, named)).map((a) => a.speakerId)).toEqual(["B"]);
    expect(await listAttributions(db, noCard)).toEqual([]);
    // The version was written with these very names: no "Names changed" notice.
    expect(namesChangedSince(await listAttributionHistory(db, old), namesAt)).toBe(false);

    expect(await importNamesForOldSessions(db, [old, named, noCard])).toEqual({ imported: [] });
    expect(await listAttributions(db, old)).toHaveLength(2);
  });
});

describe("record projection (a voice the record matched)", () => {
  // Voice A speaks 0-10 s (10 words of 1 s); the record rows cover turns of it.
  const words = (speaker: string, n = 10): Word[] =>
    Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * 1000, endMs: i * 1000 + 900, speaker, confidence: 1 }));
  const rec = (o: Partial<Attribution>) => att({ source: "record", status: "confirmed", personId: "senator", startMs: 0, endMs: 10_000, ...o });

  it("a record-matched voice counts as named (so it isn't asked about at the pause) and reaches the prompt card", () => {
    const atts = [rec({})];
    expect([...namedVoices(atts, ["A"], words("A"))]).toEqual(["A"]);
    expect([...namedVoices(atts, ["A"])]).toEqual([]); // without the transcript words: as before
    expect(lockedParticipants(atts, [person("senator", "Tereza Cristina")], words("A"))[0]).toMatchObject({ speakerId: "A", name: { value: "Tereza Cristina", source: "human" } });
    const card = cardWith({ A: none });
    const [pa] = participantsForPrompt(card, atts, [person("senator", "Tereza Cristina")], false, words("A"));
    expect(pa!.name).toMatchObject({ value: "Tereza Cristina", evidence: CONFIRMED_NAME });
  });

  it("a proposed projection is 'probably' in prompts and null in a sensitive profile", () => {
    const atts = [rec({ status: "proposed" }), rec({ status: "confirmed", startMs: 0, endMs: 5000, id: "y" })];
    const card = cardWith({ A: none });
    expect(participantsForPrompt(card, atts, [person("senator", "Tereza")], false, words("A"))[0]!.name).toMatchObject({ value: "Tereza", evidence: PROBABLE_NAME });
    expect(participantsForPrompt(card, atts, [person("senator", "Tereza")], true, words("A"))[0]!.name).toEqual(none);
    expect(lockedParticipants(atts, [person("senator", "Tereza")], words("A"))).toEqual([]); // not all rows confirmed
  });

  it("a 60/40 split voice gets no projection; 90/10 does", () => {
    const split = [rec({ endMs: 6000 }), rec({ personId: "other", startMs: 6000, endMs: 10_000, id: "o" })];
    expect([...namedVoices(split, ["A"], words("A"))]).toEqual([]);
    const mostly = [rec({ endMs: 9000 }), rec({ personId: "other", startMs: 9000, endMs: 10_000, id: "o" })];
    expect(recordProjection(mostly, "A", words("A"))).toMatchObject({ personId: "senator", confirmed: true });
    const eighty = [rec({ endMs: 8000 })];
    expect(recordProjection(eighty, "A", words("A"))).toMatchObject({ personId: "senator" });
    expect(recordProjection([rec({ endMs: 7000 })], "A", words("A"))).toBeNull();
  });

  it("human rows still win", () => {
    const atts = [rec({}), att({ speakerId: "A", personId: "mine" })];
    expect(lockedParticipants(atts, [person("senator", "S"), person("mine", "Eu")], words("A"))[0]!.name.value).toBe("Eu");
    const anon = [rec({}), att({ speakerId: "A", personId: null, status: "anonymous" })];
    expect(participantsForPrompt(cardWith({ A: none }), anon, [person("senator", "S")], false, words("A"))[0]!.name).toEqual(none);
  });

  it("importContextNames: a short context name reuses the record person (no custom person, no conflict)", async () => {
    const id = await newSession();
    const tag = `Q${Math.random().toString(36).slice(2, 8)}`;
    const senator = await upsertOfficialPerson(db, { idSystem: "senado", officialId: `t${Math.random()}`, displayName: `Zuleica ${tag}`, fullName: `Zuleica ${tag} Corrêa` });
    await saveTranscript(db, id, { language: "pt", languageConfidence: 1, durationMs: 10_000, words: words("A") });
    await replaceAiAttributions(db, id, "record", [{ speakerId: "A", startMs: 0, endMs: 10_000, personId: senator.id, status: "confirmed", confidence: 0.9, evidence: { kind: "record", speechId: "1", score: 0.9, url: "u", fetchedAt: "t" } }]);
    await importContextNames(db, id, cardWith({ A: fact(`Senadora Zuleica`, "video", "a Senadora Tereza") }));
    const atts = await listAttributions(db, id);
    expect(atts.find((a) => a.source === "transcript")).toBeUndefined(); // no whole-voice row for a voice the record named
    expect(await findPersonByName(db, "Senadora Zuleica")).toBeNull();
    expect(personAt(atts, "A", 1000)).toMatchObject({ kind: "named", personId: senator.id, confirmed: true });
    // and the prompt card carries the official name
    const card = await promptCard(db, id, cardWith({ A: fact(`Senadora Zuleica`, "video", "x") }));
    expect(card.participants.find((p) => p.speakerId === "A")!.name).toMatchObject({ value: `Zuleica ${tag}`, evidence: CONFIRMED_NAME });
  });

  it("importContextNames: a context name for a different person on a record-matched voice is still imported", async () => {
    const id = await newSession();
    const tag = `Q${Math.random().toString(36).slice(2, 8)}`;
    const senator = await upsertOfficialPerson(db, { idSystem: "senado", officialId: `t${Math.random()}`, displayName: `Zuleica ${tag}` });
    await saveTranscript(db, id, { language: "pt", languageConfidence: 1, durationMs: 10_000, words: words("A") });
    await replaceAiAttributions(db, id, "record", [{ speakerId: "A", startMs: 0, endMs: 10_000, personId: senator.id, status: "confirmed", confidence: 0.9, evidence: { kind: "record", speechId: "1", score: 0.9, url: "u", fetchedAt: "t" } }]);
    await importContextNames(db, id, cardWith({ A: fact(`Outra Pessoa ${tag}`, "video", "x") }));
    const row = (await listAttributions(db, id)).find((a) => a.source === "transcript")!;
    expect(row).toMatchObject({ speakerId: "A", startMs: null, status: "proposed" });
    expect(row.personId).not.toBe(senator.id);
  });

  it("the projection follows human corrections: re-named turns project the new person; confirming proposals confirms", () => {
    const ws = words("A");
    const proposed = [rec({ status: "proposed" })];
    expect(recordProjection(proposed, "A", ws)).toMatchObject({ personId: "senator", confirmed: false });
    // the journalist confirms them (a ranged human row for the same person)
    const confirmed = [...proposed, att({ speakerId: "A", personId: "senator", startMs: 0, endMs: 10_000 })];
    expect(recordProjection(confirmed, "A", ws)).toMatchObject({ personId: "senator", confirmed: true });
    // ...or re-names all the turns to Q
    const renamed = [rec({}), att({ speakerId: "A", personId: "q", startMs: 0, endMs: 10_000 })];
    expect(recordProjection(renamed, "A", ws)).toMatchObject({ personId: "q", confirmed: true });
    expect(lockedParticipants(renamed, [person("senator", "P"), person("q", "Q")], ws)[0]!.name.value).toBe("Q");
    // "No name" over most of the voice: no projection
    const none = [rec({}), att({ speakerId: "A", personId: null, status: "anonymous", startMs: 0, endMs: 9000 })];
    expect(recordProjection(none, "A", ws)).toBeNull();
    // a whole-voice AI proposal is not the record's: no ranged row, no projection
    expect(recordProjection([att({ source: "caption", status: "proposed", personId: "x" })], "A", ws)).toBeNull();
  });
});
