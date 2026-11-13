import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { replaceSpeechWindow, upsertMembers, upsertRollCalls, type SpeechInput } from "./monitor.ts";
import { replaceBillAuthors, upsertBills } from "./monitorRecord.ts";
import {
  forgetEmbeddings, forgetRecordEmbeddings, markEmbedded, markRecordsEmbedded, orphanEmbeddings, orphanRecordEmbeddings, recordsToEmbed,
  speechesToEmbed, speechTextsByKeys,
} from "./monitorEmbeddings.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE parl_speech_embeddings, parl_speeches, parl_members RESTART IDENTITY CASCADE");
  await pool.end();
});

const speech = (startsAt: string, text: string, summary = ""): SpeechInput => ({
  startsAt, phase: null, kind: null, summary, text, keywords: "",
});

describe("meaning index bookkeeping", () => {
  it("lists speeches with text or summary not yet embedded, newest first; marks and forgets them", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 7, name: "A", party: null, uf: null, photoUrl: null }]);
    const m = ids.get(7)!;
    await replaceSpeechWindow(db, m, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", "Primeiro discurso."),
      speech("2026-04-01T10:00", "", "Só o sumário."),
      speech("2026-05-01T10:00", "", ""),
    ]);
    const todo = await speechesToEmbed(db, 10);
    expect(todo.map((t) => t.text || t.summary)).toEqual(["Só o sumário.", "Primeiro discurso."]);
    expect(await speechesToEmbed(db, 1)).toEqual([{ speechKey: todo[0]!.speechKey, text: "", summary: "Só o sumário.", memberId: m, startsAt: "2026-04-01T10:00" }]);
    await markEmbedded(db, [{ speechKey: todo[0]!.speechKey, chunks: 1 }]);
    await markEmbedded(db, [{ speechKey: todo[0]!.speechKey, chunks: 2 }]); // upsert, not a duplicate
    expect((await speechesToEmbed(db, 10)).map((t) => t.speechKey)).toEqual([todo[1]!.speechKey]);
    expect(await orphanEmbeddings(db)).toEqual([]);

    // a revised text gets a new key: the old one is an orphan
    await replaceSpeechWindow(db, m, "2026-04-01", "2026-04-01", [speech("2026-04-01T10:00", "Agora com texto.")]);
    expect(await orphanEmbeddings(db)).toEqual([todo[0]!.speechKey]);
    await forgetEmbeddings(db, [todo[0]!.speechKey]);
    expect(await orphanEmbeddings(db)).toEqual([]);
  });

  it("speechTextsByKeys returns the text (or summary) of known keys", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 7, name: "A", party: null, uf: null, photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(7)!, "2026-02-01", "2026-11-11", [speech("2026-03-01T10:00", "Texto.", "Sumário.")]);
    const [t] = await speechesToEmbed(db, 1);
    expect(await speechTextsByKeys(db, [t!.speechKey, "missing"])).toEqual([{ speechKey: t!.speechKey, text: "Texto.", summary: "Sumário." }]);
    expect(await speechTextsByKeys(db, [])).toEqual([]);
  });
});

describe("meaning index bookkeeping: roll calls and bills", () => {
  beforeEach(async () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("TRUNCATE parl_record_embeddings, parl_roll_calls, parl_bills, parl_bill_authors RESTART IDENTITY CASCADE");
    await pool.end();
  });
  const rollCall = (id: string, date: string, description: string, billLabel: string | null = null, billSummary = "") => ({
    id, date, registeredAt: null, description, yes: 1, no: 1, other: 0, billId: null, billLabel, billSummary,
  });

  it("roll calls: label, summary and what was voted as one text; a changed text is embedded again; a removed roll call is an orphan", async () => {
    await upsertRollCalls(db, [
      rollCall("1-1", "2026-03-01", "Aprovado o projeto.", "PL 1/2026", "Dispõe sobre a aposentadoria."),
      rollCall("2-1", "2026-04-01", "Rejeitado o requerimento."),
    ]);
    const todo = await recordsToEmbed(db, "roll_call", 10);
    expect(todo.map((t) => [t.id, t.text])).toEqual([
      ["2-1", "Rejeitado o requerimento."],
      ["1-1", "PL 1/2026 — Dispõe sobre a aposentadoria. — Aprovado o projeto."],
    ]);
    expect(todo[0]!.hash).toMatch(/^[0-9a-f]{32}$/);
    await markRecordsEmbedded(db, "roll_call", todo.map((t) => ({ id: t.id, hash: t.hash })));
    expect(await recordsToEmbed(db, "roll_call", 10)).toEqual([]);

    await upsertRollCalls(db, [rollCall("1-1", "2026-03-01", "Aprovado o projeto.", "PL 1/2026", "Dispõe sobre a aposentadoria rural.")]);
    expect((await recordsToEmbed(db, "roll_call", 10)).map((t) => t.id)).toEqual(["1-1"]);

    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("DELETE FROM parl_roll_calls WHERE id = '2-1'");
    await pool.end();
    expect(await orphanRecordEmbeddings(db, "roll_call")).toEqual(["2-1"]);
    await forgetRecordEmbeddings(db, "roll_call", ["2-1"]);
    expect(await orphanRecordEmbeddings(db, "roll_call")).toEqual([]);
  });

  it("bills: only bills a member signed with a summary, label and summary as the text; one with its summary gone is an orphan", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 7, name: "A", party: null, uf: null, photoUrl: null }]);
    await upsertBills(db, [
      { id: 10, type: "PL", number: 5, year: 2026, summary: "Institui o dia do bombeiro.", presentedAt: "2026-03-01T10:00" },
      { id: 11, type: "PL", number: 6, year: 2026, summary: "Altera a lei.", presentedAt: "2026-04-01T10:00" }, // no member author
      { id: 12, type: "REQ", number: 7, year: 2026, summary: "", presentedAt: "2026-05-01T10:00" },
    ]);
    await replaceBillAuthors(db, [10, 12], [{ billId: 10, memberId: ids.get(7)!, firstAuthor: true }, { billId: 12, memberId: ids.get(7)!, firstAuthor: true }]);
    const todo = await recordsToEmbed(db, "bill", 10);
    expect(todo.map((t) => [t.id, t.text])).toEqual([["10", "PL 5/2026 — Institui o dia do bombeiro."]]);
    await markRecordsEmbedded(db, "bill", todo);
    expect(await recordsToEmbed(db, "bill", 10)).toEqual([]);
    await upsertBills(db, [{ id: 10, type: "PL", number: 5, year: 2026, summary: "", presentedAt: "2026-03-01T10:00" }]);
    expect(await orphanRecordEmbeddings(db, "bill")).toEqual(["10"]);
  });
});
