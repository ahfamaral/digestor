import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { replaceSpeechWindow, upsertMembers, type SpeechInput } from "./monitor.ts";
import { forgetEmbeddings, markEmbedded, orphanEmbeddings, speechesToEmbed, speechTextsByKeys } from "./monitorEmbeddings.ts";

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
