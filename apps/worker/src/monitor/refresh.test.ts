import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb, getMember, getProfile, getRollCall, listMemberBills, listMemberSpeeches, listMemberVotes, searchSpeeches, type Db,
} from "@digestor/core/server";
import { httpTiming } from "../records/http.js";
import { fakeCamaraMonitorFetch } from "./fakeCamaraMonitor.js";
import { nightlyWindow, refreshMonitor } from "./refresh.js";

let db: Db;
let close: () => Promise<void>;
const window = { speechesFrom: "2026-02-01", to: "2026-11-11", year: 2026, profiles: "missing" as const };

beforeAll(() => {
  httpTiming.delayMs = 0;
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE parl_votes, parl_orientations, parl_roll_calls, parl_speeches, parl_member_history, parl_presence, parl_sessions, parl_bill_authors, parl_bills, parl_members RESTART IDENTITY CASCADE`);
});

describe("refreshMonitor", () => {
  it("loads deputies, speeches, roll calls, bills and votes from the Câmara", async () => {
    const { f } = fakeCamaraMonitorFetch();
    const counts = await refreshMonitor({ db, fetch: f }, window);
    expect(counts).toMatchObject({ members: 3, speeches: { inserted: 4, kept: 0, failed: 0 }, rollCalls: 4, bills: 2 });
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
    expect(again.calls.some((c) => c.includes("/api/v2/proposicoes"))).toBe(false);
    const her = await getMember(db, "camara", 204407);
    expect((await listMemberSpeeches(db, her!.id, {})).total).toBe(4);
    expect((await listMemberVotes(db, her!.id, {})).rows.find((v) => v.rollCallId === "2449741-72")!.billLabel).toBe("PL 2942/2024");
  });

  it("keeps speeches on an empty answer", async () => {
    await refreshMonitor({ db, fetch: fakeCamaraMonitorFetch().f }, window);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f } = fakeCamaraMonitorFetch({ "/deputados/204407/discursos": { dados: [], links: [] } });
    const counts = await refreshMonitor({ db, fetch: f }, window);
    expect(counts.speeches).toEqual({ inserted: 0, kept: 1, failed: 0 });
    const her = await getMember(db, "camara", 204407);
    expect((await listMemberSpeeches(db, her!.id, {})).total).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps the in-office flags when the Câmara answers an empty in-office list", async () => {
    await refreshMonitor({ db, fetch: fakeCamaraMonitorFetch().f }, window);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f } = fakeCamaraMonitorFetch({ "deputados?itens=100": { dados: [], links: [] } });
    await refreshMonitor({ db, fetch: f }, window);
    expect((await getMember(db, "camara", 204407))!.inOffice).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/in office/));
    warn.mockRestore();
  });

  it("one deputy failing doesn't stop the others or the votes", async () => {
    const base = fakeCamaraMonitorFetch().f;
    const f = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/deputados/204379/discursos") ? new Response("{}", { status: 500 }) : base(input, init)) as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const counts = await refreshMonitor({ db, fetch: f }, window);
    warn.mockRestore();
    expect(counts.speeches).toEqual({ inserted: 4, kept: 0, failed: 1 });
    expect(counts.rollCalls).toBe(4);
    expect(counts.votes).toBe(16);
  });

  it("a year with no bulk files yet (404) refreshes deputies and speeches and doesn't throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const counts = await refreshMonitor({ db, fetch: fakeCamaraMonitorFetch().f }, { ...window, year: 2019 });
    warn.mockRestore();
    expect(counts).toMatchObject({ members: 3, speeches: { inserted: 4 }, rollCalls: 0, votes: 0 });
  });

  it("the nightly window re-reads 60 days of speeches, so late transcriptions arrive", () => {
    expect(nightlyWindow(new Date("2026-11-11T09:00:00Z"))).toEqual({ speechesFrom: "2026-09-12", to: "2026-11-11", year: 2026, profiles: "missing" });
  });

  it("a full run stores history, party on the day, profile, guidance, presence and authored bills", async () => {
    const counts = await refreshMonitor({ db, fetch: fakeCamaraMonitorFetch().f }, window);
    expect(counts).toMatchObject({ history: { ok: 3, failed: 0 }, orientations: 26, sessions: 3, presence: 2, authoredBills: 2 });
    expect(counts.profiles.failed).toBe(0);
    const her = (await getMember(db, "camara", 204407))!;
    const parties = await db.execute<{ party: string | null; n: number }>(sql`select party, count(*)::int as n from parl_speeches where member_id = ${her.id} group by 1`);
    expect(parties.rows).toEqual([{ party: "PSOL", n: 4 }]);
    expect((await getProfile(db, her.id)).profession).toBe("Bibliotecária");
    expect((await getRollCall(db, "2449741-72"))!.orientations).toHaveLength(13);
    const presence = await db.execute<{ session_id: number }>(sql`select session_id from parl_presence where member_id = ${her.id} order by 1`);
    expect(presence.rows.map((r) => Number(r.session_id))).toEqual([83188, 83243]);
    const bills = await listMemberBills(db, her.id, {});
    expect(bills.rows.map((b) => `${b.type} ${b.number}/${b.year}`)).toEqual(["PL 5330/2026", "RCP 1/2026"]);
    // authors and presence of deputies outside the list are skipped, not added as members
    expect(await getMember(db, "camara", 141533)).toBeNull();
    expect(await getMember(db, "camara", 220576)).toBeNull();
    // votes carry the party and state of the vote row
    const v = await db.execute<{ party: string | null }>(sql`select party from parl_votes where member_id = ${her.id} limit 1`);
    expect(v.rows[0]!.party).toBe("PSOL");
  });

  it('profiles: "missing" refetches only members never refreshed', async () => {
    // voters added from the votes file arrive after the profile step: their profile comes on the next run
    await refreshMonitor({ db, fetch: fakeCamaraMonitorFetch().f }, window);
    const second = fakeCamaraMonitorFetch();
    await refreshMonitor({ db, fetch: second.f }, window);
    expect(second.calls.filter((c) => c.includes("/profissoes")).length).toBeGreaterThan(0);
    const missing = fakeCamaraMonitorFetch();
    const c1 = await refreshMonitor({ db, fetch: missing.f }, window);
    expect(missing.calls.filter((c) => c.includes("/profissoes"))).toHaveLength(0);
    expect(c1.profiles).toEqual({ ok: 0, failed: 0 });
    const all = fakeCamaraMonitorFetch();
    const c2 = await refreshMonitor({ db, fetch: all.f }, { ...window, profiles: "all" });
    const members = await db.execute<{ n: number }>(sql`select count(*)::int as n from parl_members`);
    expect(all.calls.filter((c) => c.includes("/profissoes"))).toHaveLength(members.rows[0]!.n);
    expect(c2.profiles.ok).toBe(members.rows[0]!.n);
  });

  it("a missing guidance file still stores roll calls and votes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f } = fakeCamaraMonitorFetch({ "/arquivos/votacoesOrientacoes/": { status: 404 } });
    const counts = await refreshMonitor({ db, fetch: f }, window);
    warn.mockRestore();
    expect(counts).toMatchObject({ rollCalls: 4, votes: 16, orientations: 0, sessions: 3, presence: 2, authoredBills: 2 });
  });

  it("one deputy's history failing is counted and the run goes on", async () => {
    const base = fakeCamaraMonitorFetch().f;
    const f = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/deputados/204379/historico") ? new Response("{}", { status: 500 }) : base(input, init)) as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const counts = await refreshMonitor({ db, fetch: f }, window);
    warn.mockRestore();
    expect(counts.history).toEqual({ ok: 2, failed: 1 });
    expect(counts.speeches.inserted).toBe(4);
    expect(counts.rollCalls).toBe(4);
  });

  it('nightlyWindow is "all" on Mondays', () => {
    expect(nightlyWindow(new Date("2026-11-16T09:00:00Z")).profiles).toBe("all");
    expect(nightlyWindow(new Date("2026-11-17T09:00:00Z")).profiles).toBe("missing");
  });
});
