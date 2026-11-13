import { randomUUID } from "node:crypto";
import { ChromaClient } from "chromadb";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb, replaceBillAuthors, replaceSpeechWindow, upsertBills, upsertMembers, upsertRollCalls, type Db, type RollCallInput,
} from "@digestor/core/server";
import { FakeEmbedder } from "../search/embed.js";
import { MeaningIndexMissingError } from "./embedSpeeches.js";
import { embedMonitor, embedRecords, searchRecordMeaning, warmRecordIndexes, type RecordDeps } from "./embedRecords.js";

const chroma = new ChromaClient({ host: new URL(process.env.CHROMA_URL ?? "http://chroma:8000").hostname, port: 8000 });
const collections: string[] = [];
let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(async () => {
  for (const name of collections) await chroma.deleteCollection({ name }).catch(() => undefined);
  await close();
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE parl_record_embeddings, parl_speech_embeddings, parl_speeches, parl_roll_calls, parl_bills, parl_bill_authors, parl_members RESTART IDENTITY CASCADE`);
});

function deps(): RecordDeps & { embedder: FakeEmbedder } {
  const name = () => {
    const n = `test_monitor_${randomUUID().replaceAll("-", "")}`;
    collections.push(n);
    return n;
  };
  return { db, chroma, embedder: new FakeEmbedder(), collection: name(), collections: { roll_call: name(), bill: name() } };
}
const rollCall = (id: string, date: string, description: string, billSummary = ""): RollCallInput => ({
  id, date, registeredAt: null, description, yes: 1, no: 1, other: 0, billId: null, billLabel: billSummary ? "PL 1/2026" : null, billSummary,
});

describe("embedRecords (real Chroma, FakeEmbedder)", () => {
  it("embeds roll calls once, again when the text changes, and drops a removed one", async () => {
    const d = deps();
    await upsertRollCalls(db, [rollCall("1-1", "2026-03-01", "Aprovado o projeto.", "Dispõe sobre a aposentadoria."), rollCall("2-1", "2026-04-01", "Rejeitado.")]);
    expect(await embedRecords(d, "roll_call")).toEqual({ added: 2, removed: 0 });
    const col = await chroma.getCollection({ name: d.collections!.roll_call! });
    expect(await col.count()).toBe(2);
    const got = await col.get({ ids: ["1-1"], include: ["documents", "metadatas"] });
    expect(got.documents[0]).toBe("PL 1/2026 — Dispõe sobre a aposentadoria. — Aprovado o projeto.");
    expect(got.metadatas[0]).toMatchObject({ date: "2026-03-01" });
    expect(await embedRecords(d, "roll_call")).toEqual({ added: 0, removed: 0 });

    await upsertRollCalls(db, [rollCall("2-1", "2026-04-01", "Rejeitado o requerimento.")]);
    expect(await embedRecords(d, "roll_call")).toEqual({ added: 1, removed: 0 });
    expect((await col.get({ ids: ["2-1"], include: ["documents"] })).documents[0]).toBe("Rejeitado o requerimento.");

    await db.execute(sql`DELETE FROM parl_roll_calls WHERE id = '1-1'`);
    expect(await embedRecords(d, "roll_call")).toEqual({ added: 0, removed: 1 });
    expect(await col.count()).toBe(1);
  });

  it("bills: only signed bills with a summary; max limits one run", async () => {
    const d = deps();
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 7, name: "A", party: null, uf: null, photoUrl: null }]);
    await upsertBills(db, [1, 2, 3].map((i) => ({ id: i, type: "PL", number: i, year: 2026, summary: `Assunto ${i}.`, presentedAt: `2026-03-0${i}T10:00` })));
    await replaceBillAuthors(db, [1, 2], [1, 2].map((billId) => ({ billId, memberId: ids.get(7)!, firstAuthor: true })));
    expect(await embedRecords(d, "bill", { max: 1 })).toEqual({ added: 1, removed: 0 });
    expect(await embedRecords(d, "bill")).toEqual({ added: 1, removed: 0 });
    const col = await chroma.getCollection({ name: d.collections!.bill! });
    expect((await col.get({ include: [] })).ids.sort()).toEqual(["1", "2"]);
  });

  it("embedMonitor: speeches first, then roll calls and bills with what is left of the run's budget", async () => {
    const d = deps();
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 7, name: "A", party: null, uf: null, photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(7)!, "2026-02-01", "2026-11-11", [
      { startsAt: "2026-03-01T10:00", phase: null, kind: null, summary: "", text: "Um discurso.", keywords: "" },
    ]);
    await upsertRollCalls(db, [rollCall("1-1", "2026-03-01", "A."), rollCall("2-1", "2026-03-02", "B.")]);
    await upsertBills(db, [{ id: 1, type: "PL", number: 1, year: 2026, summary: "C.", presentedAt: "2026-03-01T10:00" }]);
    await replaceBillAuthors(db, [1], [{ billId: 1, memberId: ids.get(7)!, firstAuthor: true }]);
    expect(await embedMonitor(d, 2)).toEqual({
      speeches: { added: 1, removed: 0 }, rollCalls: { added: 1, removed: 0 }, bills: { added: 0, removed: 0 },
    });
    expect(await embedMonitor(d, 5)).toEqual({
      speeches: { added: 0, removed: 0 }, rollCalls: { added: 1, removed: 0 }, bills: { added: 1, removed: 0 },
    });
  });
});

describe("searchRecordMeaning", () => {
  it("scores only the given ids, best first, k respected; unknown ids skipped", async () => {
    const d = deps();
    await upsertRollCalls(db, [rollCall("1-1", "2026-03-01", "Saúde."), rollCall("2-1", "2026-03-02", "Escola."), rollCall("3-1", "2026-03-03", "Estrada.")]);
    await embedRecords(d, "roll_call");
    const hits = await searchRecordMeaning(d, "roll_call", "Escola.", ["1-1", "2-1", "9-9"], 10);
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(["1-1", "2-1"]));
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "2-1" });
    expect(hits[0]!.score).toBeCloseTo(1, 3);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    expect(await searchRecordMeaning(d, "roll_call", "Escola.", ["1-1", "2-1", "3-1"], 1)).toHaveLength(1);
    expect(await searchRecordMeaning(d, "roll_call", "Escola.", [], 10)).toEqual([]);
  });

  it("an index that was never built says so", async () => {
    const d = deps();
    await expect(searchRecordMeaning(d, "bill", "saúde", ["1"], 10)).rejects.toBeInstanceOf(MeaningIndexMissingError);
  });
});

describe("warmRecordIndexes", () => {
  it("loads the collections that exist and never throws for missing ones", async () => {
    const d = deps();
    await expect(warmRecordIndexes(d)).resolves.toBeUndefined();
    await upsertRollCalls(db, [rollCall("1-1", "2026-03-01", "A.")]);
    await embedRecords(d, "roll_call");
    await expect(warmRecordIndexes(d)).resolves.toBeUndefined();
  });
});
