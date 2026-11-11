import { beforeAll, describe, expect, it } from "vitest";
import { httpTiming } from "../records/http.js";
import { fetchBill, fetchInOfficeIds, fetchMembers, fetchSpeeches, fetchYearCsv, MONITOR_FROM } from "./camara.js";
import { fakeCamaraMonitorFetch } from "./fakeCamaraMonitor.js";

beforeAll(() => {
  httpTiming.delayMs = 0;
});

describe("Câmara monitor client", () => {
  it("starts on 1 Feb 2026", () => {
    expect(MONITOR_FROM).toBe("2026-02-01");
  });

  it("fetchMembers follows the next link and maps the deputy", async () => {
    const { f, calls } = fakeCamaraMonitorFetch();
    const rows = await fetchMembers(f, "2026-02-01", "2026-11-11");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("dataInicio=2026-02-01&dataFim=2026-11-11&itens=100");
    expect(calls[1]).toContain("pagina=2");
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.externalId === 204407)).toEqual({
      house: "camara", externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS",
      photoUrl: "https://www.camara.leg.br/internet/deputado/bandep/204407.jpg",
    });
  });

  it("fetchInOfficeIds lists today's deputies", async () => {
    const { f } = fakeCamaraMonitorFetch();
    expect((await fetchInOfficeIds(f)).sort()).toEqual([204379, 204407]);
  });

  it("fetchSpeeches maps and orders the speeches, empty text kept as empty", async () => {
    const { f, calls } = fakeCamaraMonitorFetch();
    const rows = await fetchSpeeches(f, 204407, "2026-02-01", "2026-11-11");
    expect(calls[0]).toContain("/deputados/204407/discursos?dataInicio=2026-02-01&dataFim=2026-11-11&itens=100&ordenarPor=dataHoraInicio&ordem=ASC");
    expect(rows.map((r) => r.startsAt)).toEqual(["2026-02-24T19:08", "2026-03-10T19:40", "2026-10-14T20:12", "2026-11-10T18:20"]);
    expect(rows[0]).toMatchObject({ phase: "Breves Comunicações", kind: "BREVES COMUNICAÇÕES" });
    expect(rows[0]!.keywords).toContain("Feminicídio");
    expect(rows[0]!.summary).toMatch(/^A Deputada/);
    expect(rows[0]!.text).toMatch(/^A SRA\. FERNANDA MELCHIONNA/);
    expect(rows[2]!.text).toBe("");
  });

  it("fetchSpeeches: an unknown deputy (404) gives no speeches", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    expect(await fetchSpeeches(notFound, 999, "2026-02-01", "2026-11-11")).toEqual([]);
  });

  it("fetchYearCsv downloads the year's bulk file", async () => {
    const { f, calls } = fakeCamaraMonitorFetch();
    const text = await fetchYearCsv(f, "votacoes", 2026);
    expect(calls[0]).toBe("https://dadosabertos.camara.leg.br/arquivos/votacoes/csv/votacoes-2026.csv");
    expect(text).toContain("2449741-72");
    await expect(fetchYearCsv(f, "votacoes", 2019)).rejects.toThrow(/Câmara/);
  });

  it("fetchBill by id and by label", async () => {
    const { f } = fakeCamaraMonitorFetch();
    const byId = await fetchBill(f, { id: 2462009 });
    expect(byId).toMatchObject({ id: 2462009, label: "PL 3880/2024" });
    expect(byId!.summary).toMatch(/^Altera a Lei nº 11\.340/);
    expect(await fetchBill(f, { label: "PL 2942/2024" })).toMatchObject({ id: 2449741, label: "PL 2942/2024" });
    expect(await fetchBill(f, { label: "PL 1/2024" })).toBeNull();
    expect(await fetchBill(f, { id: 1 })).toBeNull();
    expect(await fetchBill(f, { label: "not a label" })).toBeNull();
    expect(await fetchBill(f, {})).toBeNull();
  });
});
