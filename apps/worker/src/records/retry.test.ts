import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { claimRecordFetch, createDb, createSession, getSessionRecord, linkRecord, waitRecordFetch, type Db } from "@digestor/core/server";
import type { RecordRef } from "@digestor/core";
import { runRecordRetries } from "./retry.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => ({ db, close } = createDb(process.env.TEST_DATABASE_URL!)));
afterAll(() => close());
beforeEach(async () => { await db.execute(sql`TRUNCATE sessions RESTART IDENTITY CASCADE`); });

const ref: RecordRef = { chamber: "senado", date: "2026-11-03", sessionCode: null, url: "https://x" };
const NOW = new Date("2026-11-04T12:00:00Z");

async function waitingSession(retryAt: Date) {
  const s = await createSession(db, { source: "upload", title: "r" });
  await linkRecord(db, s.id, ref);
  await claimRecordFetch(db, s.id);
  await waitRecordFetch(db, s.id, ref, retryAt, "line");
  return s.id;
}

describe("runRecordRetries", () => {
  it("claims a due row and sends one session.names job; leaves a row that is not due", async () => {
    const due = await waitingSession(new Date("2026-11-04T11:00:00Z"));
    const later = await waitingSession(new Date("2026-11-04T18:00:00Z"));
    const sent: string[] = [];
    expect(await runRecordRetries({ db, send: async (id) => void sent.push(id) }, NOW)).toBe(1);
    expect(sent).toEqual([due]);
    expect((await getSessionRecord(db, due))!.status).toBe("pending");
    expect((await getSessionRecord(db, later))!.status).toBe("waiting");
  });

  it("a failed send puts the row back to waiting an hour later", async () => {
    const id = await waitingSession(new Date("2026-11-04T11:00:00Z"));
    await runRecordRetries({ db, send: async () => { throw new Error("boom"); } }, NOW);
    expect(await getSessionRecord(db, id)).toMatchObject({ status: "waiting", retryAt: new Date("2026-11-04T13:00:00Z") });
  });
});
