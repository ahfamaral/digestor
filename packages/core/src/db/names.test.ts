import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { personAt } from "../attribution.ts";
import { createDb, type Db } from "./client.ts";
import { startAnalysisVersion } from "./analysis.ts";
import { createSession, saveContextCard, type Session } from "./repo.ts";
import { analysisVersions, attributions } from "./schema.ts";
import { eq } from "drizzle-orm";
import {
  createCustomPerson, findPersonByName, getPersons, listAttributionHistory, listAttributions, replaceAiAttributions, searchPersons,
  sessionsWithoutNames, setHumanAttribution, upsertOfficialPerson,
} from "./names.ts";

let db: Db;
let close: () => Promise<void>;
let s: Session;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions, persons RESTART IDENTITY CASCADE");
  await pool.end();
  s = await createSession(db, { title: "T", source: "upload" });
});

const ai = (personId: string, over = {}) => ({
  speakerId: "B", startMs: null, endMs: null, personId, status: "proposed" as const, confidence: 0.6,
  evidence: { kind: "quote" as const, quote: "q" }, ...over,
});
const human = (personId: string | null, over = {}) => ({
  sessionId: s.id, speakerId: "B", startMs: null, endMs: null, personId, ownerId: "owner", ...over,
});

describe("attributions", () => {
  it("setHumanAttribution supersedes same-scope rows and keeps history", async () => {
    const p = await createCustomPerson(db, { displayName: "Ana", createdBy: "owner" });
    await setHumanAttribution(db, human(p.id));
    const second = await setHumanAttribution(db, human(p.id));
    expect(second).toMatchObject({ source: "human", status: "confirmed", confidence: 1, evidence: { kind: "none" } });
    expect((await listAttributions(db, s.id)).filter((a) => a.speakerId === "B")).toHaveLength(1);
    const raw = await db.select().from(attributions).where(eq(attributions.sessionId, s.id));
    expect(raw).toHaveLength(2);
    expect(raw.filter((r) => r.supersededAt !== null)).toHaveLength(1);
    await setHumanAttribution(db, human(p.id, { startMs: 1000, endMs: 5000 }));
    const cur = await listAttributions(db, s.id);
    expect(cur).toHaveLength(2);
    expect(cur.some((a) => a.startMs === null)).toBe(true);
  });

  it("a null person is anonymous", async () => {
    const a = await setHumanAttribution(db, human(null));
    expect(a).toMatchObject({ personId: null, status: "anonymous" });
  });

  it("replaceAiAttributions never supersedes human rows", async () => {
    const [p1, p3] = [
      await createCustomPerson(db, { displayName: "P1", createdBy: "owner" }),
      await createCustomPerson(db, { displayName: "P3", createdBy: "owner" }),
    ];
    await setHumanAttribution(db, human(p3.id));
    await replaceAiAttributions(db, s.id, "transcript", [ai(p1.id)]);
    const r = personAt(await listAttributions(db, s.id), "B", 0);
    expect(r).toMatchObject({ kind: "named", personId: p3.id });
    await replaceAiAttributions(db, s.id, "transcript", []);
    const cur = await listAttributions(db, s.id);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.source).toBe("human");
  });

  it("replaceAiAttributions is idempotent", async () => {
    const p = await createCustomPerson(db, { displayName: "P1", createdBy: "owner" });
    const rows = [ai(p.id), ai(p.id, { speakerId: "C" })];
    await replaceAiAttributions(db, s.id, "transcript", rows);
    await replaceAiAttributions(db, s.id, "transcript", rows);
    expect(await listAttributions(db, s.id)).toHaveLength(2);
  });

  it("listAttributionHistory returns superseded rows too", async () => {
    const p1 = await createCustomPerson(db, { displayName: "P1", createdBy: "owner" });
    const p2 = await createCustomPerson(db, { displayName: "P2", createdBy: "owner" });
    await replaceAiAttributions(db, s.id, "transcript", [ai(p1.id)]);
    await setHumanAttribution(db, human(p2.id));
    await setHumanAttribution(db, human(p1.id));
    const history = await listAttributionHistory(db, s.id);
    expect(history.map((a) => [a.source, a.personId, a.supersededAt === null])).toEqual([
      ["transcript", p1.id, true],
      ["human", p2.id, false],
      ["human", p1.id, true],
    ]);
    expect(await listAttributions(db, s.id)).toHaveLength(2);
  });

  it("sessionsWithoutNames: sessions with a context card and no attribution row at all", async () => {
    const card = (await import("../schemas.ts")).ContextCardSchema.parse({
      language: { value: null, source: null, evidence: null }, profile: { value: "interview", confidence: 1, evidence: null },
      title: { value: null, source: null, evidence: null }, summary: "", setting: { value: null, source: null, evidence: null },
      dateOrYear: { value: null, source: null, evidence: null }, participants: [], sufficient: true, openQuestions: [],
    });
    const named = await createSession(db, { title: "named", source: "upload" });
    const noCard = await createSession(db, { title: "no card", source: "upload" });
    await saveContextCard(db, s.id, card, 1);
    await saveContextCard(db, named.id, card, 1);
    await setHumanAttribution(db, { ...human(null), sessionId: named.id });
    expect(await sessionsWithoutNames(db, [s.id, named.id, noCard.id])).toEqual([s.id]);
    const all = await sessionsWithoutNames(db);
    expect(all).toContain(s.id);
    expect(all).not.toContain(named.id);
    expect(await sessionsWithoutNames(db, [named.id, noCard.id])).toEqual([]);
    expect(await sessionsWithoutNames(db, [])).toEqual([]);
  });
});

describe("persons", () => {
  it("upsertOfficialPerson updates by official id", async () => {
    const base = { chamber: "senado" as const, officialId: "5894", displayName: "Fulano" };
    const a = await upsertOfficialPerson(db, { ...base, party: "AA" });
    const b = await upsertOfficialPerson(db, { ...base, party: "BB" });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ party: "BB", kind: "official", officialIds: { senado: "5894" } });
    const c = await upsertOfficialPerson(db, { chamber: "camara", officialId: "5894", displayName: "Outro" });
    expect(c.id).not.toBe(a.id);
  });

  it("findPersonByName ignores accents and case; searchPersons finds by part of the name", async () => {
    const p = await upsertOfficialPerson(db, { chamber: "camara", officialId: "1", displayName: "Tabata Amaral", fullName: "Tabata Claudia Amaral de Pontes" });
    expect((await findPersonByName(db, "TÁBATA amaral"))?.id).toBe(p.id);
    expect((await findPersonByName(db, "tabata claudia amaral de pontes"))?.id).toBe(p.id);
    expect(await findPersonByName(db, "tabata")).toBeNull();
    expect((await searchPersons(db, "Claudia")).map((x) => x.id)).toEqual([p.id]);
    expect(await searchPersons(db, "zzz")).toEqual([]);
    expect((await getPersons(db, [p.id])).length).toBe(1);
  });
});

describe("analysis versions", () => {
  it("new analysis versions record names_at", async () => {
    const v = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "r", models: {}, promptVersions: {} });
    const [row] = await db.select().from(analysisVersions).where(eq(analysisVersions.id, v.id));
    expect(row!.namesAt).toBeInstanceOf(Date);
  });
});
