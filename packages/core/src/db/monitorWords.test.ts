import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { replaceSpeechWindow, upsertMembers, type MemberInput, type SpeechInput } from "./monitor.ts";
import { distinctiveWords, refreshWordCounts } from "./monitorWords.ts";

let db: Db;
let close: () => Promise<void>;
let pool: pg.Pool;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
});
afterAll(async () => {
  await pool.end();
  await close();
});
beforeEach(async () => {
  await pool.query("TRUNCATE parl_word_counts, parl_speeches, parl_members RESTART IDENTITY CASCADE");
});

const member = (externalId: number, name: string, party: string): MemberInput => ({ house: "camara", externalId, name, party, uf: "SP", photoUrl: null });
const speech = (startsAt: string, text: string): SpeechInput => ({ startsAt, phase: "Breves Comunicações", kind: "Discurso", summary: "", text, keywords: "" });
const header = (name: string, party: string) => `O SR. ${name} (${party} - SP. Sem revisão do orador.) - `;
/** A ten-word corpus needs a light prior and no significance bar to show anything. */
const SMALL = { alpha0: 5, minZ: 0.5, minCount: 1 };
const counts = async () =>
  (await pool.query<{ member: number; party: string; month: string; stem: string; n: number }>(
    "SELECT m.external_id AS member, w.party, to_char(w.month, 'YYYY-MM-DD') AS month, w.stem, w.n FROM parl_word_counts w JOIN parl_members m ON m.id = w.member_id ORDER BY 1, 3, 4",
  )).rows;

/** Two deputies: Ana (PSOL) speaks about pesticides, Bruno (PL) about public safety; both about schools. */
async function seed() {
  const ids = await upsertMembers(db, [member(1, "Ana Teste", "PSOL"), member(2, "Bruno Teste", "PL")]);
  const ana = ids.get(1)!;
  const bruno = ids.get(2)!;
  await replaceSpeechWindow(db, ana, "2026-02-01", "2026-11-30", [
    speech("2026-03-10T15:00", `${header("ANA TESTE", "PSOL")}Sr. Presidente, os agrotóxicos envenenam. Agrotóxicos na escola, agrotóxico na merenda! Agrotóxicos 2026.`),
    speech("2026-04-02T15:00", `${header("ANA TESTE", "PSOL")}Presidente, a escola pública e os agrotóxicos.`),
  ]);
  await replaceSpeechWindow(db, bruno, "2026-02-01", "2026-11-30", [
    speech("2026-03-11T15:00", `${header("BRUNO TESTE", "PL")}Presidente, segurança pública: polícia na rua, polícia na escola. Segurança!`),
  ]);
  await pool.query("UPDATE parl_speeches SET party = 'PSOL' WHERE member_id = $1", [ana]);
  await pool.query("UPDATE parl_speeches SET party = 'PL' WHERE member_id = $1", [bruno]);
  return { ana, bruno };
}

describe("refreshWordCounts", () => {
  it("counts stems per deputy, party on the day and month, without the header, the stoplist, numbers or short stems", async () => {
    await seed();
    const n = await refreshWordCounts(db);
    const rows = await counts();
    expect(n).toBe(rows.length);
    const ana = rows.filter((r) => r.member === 1);
    expect(ana.filter((r) => r.month === "2026-03-01").map((r) => [r.stem, r.n])).toEqual([
      ["agrotox", 4], ["envenen", 1], ["escol", 1], ["merend", 1],
    ]);
    expect(ana.every((r) => r.party === "PSOL")).toBe(true);
    const stems = new Set(rows.map((r) => r.stem));
    // "presidente" (stoplist), the speaker's own name in the header, "2026", "os"/"na" (short or stopwords) are not counted
    for (const gone of ["president", "ana", "test", "bruno", "2026", "sr", "revisa", "orador"]) expect(stems.has(gone)).toBe(false);
  });

  it("replaces everything on a rerun, and a speech without a party counts under ''", async () => {
    const { bruno } = await seed();
    await refreshWordCounts(db);
    await pool.query("UPDATE parl_speeches SET party = NULL WHERE member_id = $1", [bruno]);
    await refreshWordCounts(db);
    const rows = (await counts()).filter((r) => r.member === 2);
    expect(rows.find((r) => r.stem === "polic")).toMatchObject({ party: "", n: 2 });
    expect(rows.filter((r) => r.stem === "polic")).toHaveLength(1);
  });
});

describe("chair turns and vocatives", () => {
  it("the chair's turns inside a speech and the vocative to the chair's full name don't count for the speaker", async () => {
    const ids = await upsertMembers(db, [member(1, "Ana Teste", "PSOL")]);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-30", [
      speech(
        "2026-03-10T15:00",
        `${header("ANA TESTE", "PSOL")}Sr. Presidente Charles Fernandes, a merenda escolar. ` +
          "O SR. PRESIDENTE (Charles Fernandes. Bloco/PSD - BA) - Conclua, Deputada, o cronômetro terminou. " +
          "A SRA. ANA TESTE (Bloco/PSOL - SP) - Concluo: merenda. Presidente Charles, obrigada.",
      ),
      // the chair's own speech keeps its opening turn
      speech("2026-03-11T15:00", "O SR. PRESIDENTE (Charles Fernandes. Bloco/PSD - BA) - Está aberta a sessão. Cronômetro ligado."),
    ]);
    await refreshWordCounts(db);
    const rows = await counts();
    const first = rows.filter((r) => r.month === "2026-03-01").map((r) => [r.stem, r.n]);
    // "cronômetro" twice: once from the chair's own speech, never from the turn inside Ana's; "fernandes" gone,
    // a first name alone ("Presidente Charles") stays
    expect(first).toEqual([["abert", 1], ["charl", 1], ["conclu", 1], ["cronometr", 1], ["escol", 1], ["lig", 1], ["merend", 2]]);
  });
});

describe("distinctiveWords", () => {
  it("lists only words said at least 5 times", async () => {
    await seed();
    await refreshWordCounts(db);
    const ana = (await pool.query<{ id: number }>("SELECT id FROM parl_members WHERE external_id = 1")).rows[0]!.id;
    const r = await distinctiveWords(db, { memberId: ana }, { minTokens: 5, minMonthTokens: 1, alpha0: 5, minZ: 0.5 });
    expect(r.words.map((w) => [w.stem, w.count])).toEqual([["agrotox", 5]]);
  });

  it("ranks the word only the deputy uses first, labelled with its most common written form", async () => {
    await seed();
    await refreshWordCounts(db);
    const ana = (await pool.query<{ id: number }>("SELECT id FROM parl_members WHERE external_id = 1")).rows[0]!.id;
    const r = await distinctiveWords(db, { memberId: ana }, { minTokens: 5, minMonthTokens: 1, year: 2026, ...SMALL });
    expect(r.enough).toBe(true);
    expect(r.words[0]).toMatchObject({ stem: "agrotox", label: "agrotóxicos", count: 5 });
    // shared by both and said by Bruno too: not "more than the chamber"
    expect(r.words.map((w) => w.stem)).not.toContain("escol");
    // the share compares with the rest of the chamber: nobody else said it in March
    expect(r.words[0]!.months.find((m) => m.month === "2026-03")!.share).toBe(Infinity);
    // "escola" in March: 1 of Ana's 7 words, 1 of the rest's 7 (Bruno) → about as often
    const all = await distinctiveWords(db, { memberId: ana }, { minTokens: 5, minMonthTokens: 1, ...SMALL, minZ: -100 });
    expect(all.words.find((w) => w.stem === "escol")!.months.find((m) => m.month === "2026-03")!.share).toBeCloseTo(1, 5);
    // one entry per month with text in the chamber
    expect(r.words[0]!.months.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
  });

  it("works for a party (party on the day), and a party with one deputy is that deputy's words", async () => {
    await seed();
    await refreshWordCounts(db);
    const r = await distinctiveWords(db, { party: "PL" }, { minTokens: 5, minMonthTokens: 1, ...SMALL });
    expect(r.enough).toBe(true);
    expect(new Map(r.words.map((w) => [w.stem, w.label]))).toEqual(new Map([["polic", "polícia"], ["seguranc", "segurança"], ["rua", "rua"]]));
  });

  it("a month with too little text has no share", async () => {
    await seed();
    await refreshWordCounts(db);
    const ana = (await pool.query<{ id: number }>("SELECT id FROM parl_members WHERE external_id = 1")).rows[0]!.id;
    const r = await distinctiveWords(db, { memberId: ana }, { minTokens: 5, minMonthTokens: 5, ...SMALL });
    const months = r.words[0]!.months;
    expect(months.find((m) => m.month === "2026-03")!.share).not.toBeNull();
    expect(months.find((m) => m.month === "2026-04")!.share).toBeNull(); // 3 words in April
  });

  it("below the minimum, or with no text at all, says there isn't enough instead of showing words", async () => {
    const { ana } = await seed();
    await refreshWordCounts(db);
    expect(await distinctiveWords(db, { memberId: ana })).toEqual({ enough: false, words: [] }); // 10 words < 1,500
    expect(await distinctiveWords(db, { party: "NOVO" }, { minTokens: 1 })).toEqual({ enough: false, words: [] });
    expect(await distinctiveWords(db, { memberId: 999 }, { minTokens: 1 })).toEqual({ enough: false, words: [] });
  });
});
