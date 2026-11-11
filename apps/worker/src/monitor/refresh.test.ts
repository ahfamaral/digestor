import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getMember, listMemberSpeeches, listMemberVotes, searchSpeeches, type Db } from "@digestor/core/server";
import { httpTiming } from "../records/http.js";
import { fakeCamaraMonitorFetch } from "./fakeCamaraMonitor.js";
import { refreshMonitor } from "./refresh.js";

let db: Db;
let close: () => Promise<void>;
const window = { speechesFrom: "2026-02-01", to: "2026-11-11", year: 2026 };

beforeAll(() => {
  httpTiming.delayMs = 0;
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE`);
});

describe("refreshMonitor", () => {
  it("loads deputies, speeches, roll calls, bills and votes from the Câmara", async () => {
    const { f } = fakeCamaraMonitorFetch();
    const counts = await refreshMonitor({ db, fetch: f }, window);
    expect(counts).toMatchObject({ members: 3, speeches: { inserted: 4, kept: 0 }, rollCalls: 4, bills: 2 });
    const her = await getMember(db, "camara", 204407);
    expect(her).toMatchObject({ name: "Fernanda Melchionna", party: "PSOL", uf: "RS", inOffice: true });
    expect((await listMemberSpeeches(db, her!.id, {})).total).toBe(4);
    const votes = await listMemberVotes(db, her!.id, {});
    expect(votes.rows.map((v) => [v.rollCallId, v.vote, v.billLabel])).toEqual([
      ["2462009-57", "Não", "PL 3880/2024"], ["2449741-72", "Sim", "PL 2942/2024"], ["2600277-9", "Sim", null], ["2601223-8", "Sim", "REQ 284/2026"],
    ]);
    expect(votes.rows.find((v) => v.rollCallId === "2462009-57")!.billSummary).toMatch(/Lei Maria da Penha/);
    // a voter missing from the deputies list is added from the votes file, so the row has a name
    expect(await getMember(db, "camara", 220714)).toMatchObject({ inOffice: false, name: expect.any(String) });
    const found = await searchSpeeches(db, { terms: ["feminicídio"], memberId: her!.id });
    expect(found.total).toBeGreaterThan(0);
    expect(counts.votes).toBe(16);
  });

  it("is idempotent: a rerun keeps the same rows and fetches no bill twice", async () => {
    const { f } = fakeCamaraMonitorFetch();
    await refreshMonitor({ db, fetch: f }, window);
    const again = fakeCamaraMonitorFetch();
    const counts = await refreshMonitor({ db, fetch: again.f }, window);
    expect(counts).toMatchObject({ members: 3, speeches: { inserted: 4, kept: 0 }, rollCalls: 4, votes: 16, bills: 0 });
    expect(again.calls.some((c) => c.includes("/proposicoes"))).toBe(false);
    const her = await getMember(db, "camara", 204407);
    expect((await listMemberSpeeches(db, her!.id, {})).total).toBe(4);
    expect((await listMemberVotes(db, her!.id, {})).rows.find((v) => v.rollCallId === "2449741-72")!.billLabel).toBe("PL 2942/2024");
  });

  it("keeps speeches on an empty answer", async () => {
    await refreshMonitor({ db, fetch: fakeCamaraMonitorFetch().f }, window);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f } = fakeCamaraMonitorFetch({ "/deputados/204407/discursos": { dados: [], links: [] } });
    const counts = await refreshMonitor({ db, fetch: f }, window);
    expect(counts.speeches).toEqual({ inserted: 0, kept: 1 });
    const her = await getMember(db, "camara", 204407);
    expect((await listMemberSpeeches(db, her!.id, {})).total).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
