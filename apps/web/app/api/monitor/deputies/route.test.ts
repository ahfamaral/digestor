import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertMembers } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { GET } from "./route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
beforeEach(async () => {
  await h.db.execute("TRUNCATE parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE");
});

const get = async (q: string) => (await GET(new Request(`http://localhost/api/monitor/deputies?q=${encodeURIComponent(q)}`))).json();

describe("GET /api/monitor/deputies", () => {
  it("fewer than 2 letters → empty", async () => {
    await upsertMembers(h.db, [{ house: "camara", externalId: 1, name: "Ana", party: null, uf: null, photoUrl: null }]);
    expect(await get("a")).toEqual({ rows: [], more: false });
    expect(await get(" \u0000a\u0007 ")).toEqual({ rows: [], more: false });
    expect(await GET(new Request("http://localhost/api/monitor/deputies")).then((r) => r.json())).toEqual({ rows: [], more: false });
  });

  it("9 matches → 8 rows and more", async () => {
    await upsertMembers(h.db, Array.from({ length: 9 }, (_, i) => ({ house: "camara" as const, externalId: 100 + i, name: `Silva ${i}`, party: null, uf: null, photoUrl: null })));
    const r = await get("silva");
    expect(r.rows).toHaveLength(8);
    expect(r.more).toBe(true);
  });

  it("control characters are stripped; 300 characters answer, never fail", async () => {
    await upsertMembers(h.db, [{ house: "camara", externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", photoUrl: null }]);
    expect((await get("melch\u0000ionna")).rows).toHaveLength(0);
    expect((await get("\u0007melchionna\u0000")).rows.map((m: { externalId: number }) => m.externalId)).toEqual([204407]);
    const res = await GET(new Request(`http://localhost/api/monitor/deputies?q=${"m".repeat(300)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], more: false });
  });

  it("row shape", async () => {
    await upsertMembers(h.db, [
      { house: "camara", externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", photoUrl: "https://www.camara.leg.br/internet/deputado/bandep/204407.jpg" },
    ]);
    expect(await get("fernanda")).toEqual({
      rows: [{
        externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", photoUrl: "https://www.camara.leg.br/internet/deputado/bandep/204407.jpg",
        inOffice: false,
      }],
      more: false,
    });
  });
});
