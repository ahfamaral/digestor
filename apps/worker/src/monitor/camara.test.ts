import { beforeAll, describe, expect, it } from "vitest";
import { httpTiming } from "../records/http.js";
import {
  fetchBlocs,
  fetchBill, fetchHistory, fetchInOfficeIds, fetchMembers, fetchProfile, fetchSpeeches, fetchYearCsv, LEGISLATURE_FROM, mergeMandates, MONITOR_FROM,
} from "./camara.js";
import { fakeCamaraMonitorFetch, monitorFixture } from "./fakeCamaraMonitor.js";

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

  it("fetchSpeeches decodes the HTML entities the Câmara leaves in summaries", async () => {
    const body = { dados: [{ dataHoraInicio: "2026-04-08T11:28", sumario: "o feminicídio.&nbsp;Destacou A &amp; B &gt; C &#39;x&#39; &#8211; y", transcricao: "t", keywords: "" }], links: [] };
    const { f } = fakeCamaraMonitorFetch({ "/deputados/204407/discursos": body });
    const [row] = await fetchSpeeches(f, 204407, "2026-02-01", "2026-11-11");
    expect(row!.summary).toBe("o feminicídio. Destacou A & B > C 'x' – y");
  });

  it("fetchSpeeches keeps the Câmara's text page (https on a Câmara host only)", async () => {
    const { f } = fakeCamaraMonitorFetch();
    const rows = await fetchSpeeches(f, 204407, "2026-02-01", "2026-11-11");
    expect(rows[0]!.urlText).toMatch(/^https:\/\/imagem\.camara\.gov\.br\/dc_20b\.asp\?/);
    const odd = { dados: [
      { dataHoraInicio: "2026-04-08T11:28", sumario: "s", transcricao: "t", keywords: "", urlTexto: "javascript:alert(1)" },
      { dataHoraInicio: "2026-04-08T11:32", sumario: "s", transcricao: "t", keywords: "", urlTexto: "https://evil.example/x.camara.gov.br" },
      { dataHoraInicio: "2026-04-08T11:36", sumario: "s", transcricao: "t", keywords: "", urlTexto: "" },
      { dataHoraInicio: "2026-04-08T11:40", sumario: "s", transcricao: "t", keywords: "", urlTexto: "http://www.camara.leg.br/x" },
    ], links: [] };
    const other = await fetchSpeeches(fakeCamaraMonitorFetch({ "/deputados/204407/discursos": odd }).f, 204407, "2026-02-01", "2026-11-11");
    expect(other.map((r) => r.urlText)).toEqual([null, null, null, "https://www.camara.leg.br/x"]);
  });

  it("fetchSpeeches maps Windows-1252 leftovers (C1 characters) to what they stand for", async () => {
    const body = { dados: [{ dataHoraInicio: "2026-04-08T11:28", sumario: "\u0093aspas\u0094 \u0096 x", transcricao: "esquecidos \u0097 pelos\u0085\u0081fim", keywords: "a\u0092b" }], links: [] };
    const [row] = await fetchSpeeches(fakeCamaraMonitorFetch({ "/deputados/204407/discursos": body }).f, 204407, "2026-02-01", "2026-11-11");
    expect(row!.summary).toBe("“aspas” – x");
    expect(row!.text).toBe("esquecidos — pelos… fim");
    expect(row!.keywords).toBe("a’b");
    expect(row!.textFile).toBe(false);
  });

  it("fetchSpeeches: a speech published as an attached .docx keeps only its heading", async () => {
    const docx = "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO X (SEM REGISTRO TAQUIGRÁFICO). PK\u0003\u0004\u0014\u0000!J\ufffdqm([Content_Types].xml \ufffd\ufffd word/document.xml";
    const body = { dados: [{ dataHoraInicio: "2026-10-13T13:55", sumario: "", transcricao: docx, keywords: "" }], links: [] };
    const [row] = await fetchSpeeches(fakeCamaraMonitorFetch({ "/deputados/204407/discursos": body }).f, 204407, "2026-02-01", "2026-11-11");
    expect(row!.text).toBe("DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO X (SEM REGISTRO TAQUIGRÁFICO).");
    expect(row!.textFile).toBe(true);
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

  it("fetchYearCsv retries a download cut off mid-body", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('"id";"data"\n'));
            c.error(new TypeError("terminated"));
          },
        });
        return new Response(body, { status: 200 });
      }
      return new Response('"id";"data"\n"1-1";"2026-01-01"\n', { status: 200 });
    }) as typeof fetch;
    expect(await fetchYearCsv(f, "votacoes", 2026)).toContain("1-1");
    expect(n).toBe(2);
  });

  it("fetchYearCsv gives up after three cut-off downloads", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new TypeError("terminated");
    }) as typeof fetch;
    await expect(fetchYearCsv(f, "votacoes", 2026)).rejects.toThrow();
    expect(n).toBe(3);
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

  it("fetchHistory maps 220576", async () => {
    const { f, calls } = fakeCamaraMonitorFetch();
    const rows = await fetchHistory(f, 220576);
    expect(calls[0]).toContain("/deputados/220576/historico");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ at: "2023-02-01T00:00", party: "UNIÃO", uf: "AL", status: null, description: "Nome no início da legislatura / Partido no início da legislatura" });
    expect(rows[2]).toMatchObject({ party: "PL", at: "2026-04-29T22:10", description: "Alteração de partido", status: "Exercício" });
  });

  it("fetchHistory keeps the current legislature only (73806 lists a 1991 PFL row dated 2023-02-01)", async () => {
    const { f } = fakeCamaraMonitorFetch();
    const rows = await fetchHistory(f, 73806);
    expect(rows).toHaveLength(19);
    expect(rows.some((r) => r.party === "PFL")).toBe(false);
    expect(rows.filter((r) => r.status === "Licença").length).toBeGreaterThan(0);
  });

  it("fetchHistory of 204407 drops rows labelled legislature 56 and 58", async () => {
    const { f } = fakeCamaraMonitorFetch();
    expect((await fetchHistory(f, 204407)).map((r) => r.at)).toEqual(["2023-02-01T00:00", "2023-02-01T12:05"]);
  });

  it("fetchHistory: an unknown deputy (404) has no history", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    expect(await fetchHistory(notFound, 999)).toEqual([]);
  });

  it("fetchProfile maps 204407", async () => {
    const { f, calls } = fakeCamaraMonitorFetch();
    const p = await fetchProfile(f, 204407);
    expect(LEGISLATURE_FROM).toBe("2023-02-01");
    expect(calls.some((c) => c.includes("/deputados/204407/orgaos?dataInicio=2023-02-01&itens=100"))).toBe(true);
    expect(p.profession).toBe("Bibliotecária");
    expect(p.externalMandates).toEqual([{ office: "Vereador(a)", place: "Porto Alegre", uf: "RS", from: 2009, to: 2018, party: "PSOL" }]);
    expect(p.fronts.length).toBeGreaterThan(0);
    expect(p.fronts).toContain("Frente Parlamentar pela Duplicação da BR-290");
    expect(p.positions).toContainEqual({
      body: "CMULHER", bodyName: "Comissão de Defesa dos Direitos da Mulher", title: "Titular", from: "2023-03-15", to: "2023-12-15",
    });
    expect(p.positions).toHaveLength(40);
  });

  it("fetchProfile keeps only this legislature's fronts", async () => {
    const { f } = fakeCamaraMonitorFetch();
    const all = (JSON.parse(monitorFixture("frentes-204407.recorded.json")) as { dados: { titulo: string; idLegislatura: number }[] }).dados;
    const p = await fetchProfile(f, 204407);
    expect(p.fronts).toEqual(all.filter((r) => r.idLegislatura === 57).map((r) => r.titulo));
    expect(p.fronts.length).toBeLessThan(all.length);
  });

  it("fetchProfile of a deputy the API doesn't know is empty", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    expect(await fetchProfile(notFound, 999)).toEqual({ profession: null, externalMandates: [], fronts: [], positions: [] });
  });

  it("mergeMandates joins consecutive terms, keeps a gap and a party change apart", () => {
    const m = (from: number, to: number | null, party: string | null = "PSOL", place = "Porto Alegre") => ({ office: "Vereador(a)", place, uf: "RS", from, to, party });
    expect(mergeMandates([m(2013, 2016), m(2009, 2012), m(2017, 2018)])).toEqual([m(2009, 2018)]);
    expect(mergeMandates([m(2001, 2004), m(2009, 2012)])).toEqual([m(2001, 2004), m(2009, 2012)]);
    expect(mergeMandates([m(2009, 2012), m(2013, 2016, "PT")])).toEqual([m(2009, 2012), m(2013, 2016, "PT")]);
    expect(mergeMandates([m(2009, 2012), m(2013, 2016, "PSOL", "Canoas")])).toEqual([m(2009, 2012), m(2013, 2016, "PSOL", "Canoas")]);
    expect(mergeMandates([m(2009, null), m(2013, 2016)])).toEqual([m(2009, null), m(2013, 2016)]);
  });

  it("fetchBlocs: the legislature's blocs with their full names and member parties, as recorded", async () => {
    const { f, calls } = fakeCamaraMonitorFetch();
    const blocs = await fetchBlocs(f);
    expect(calls[0]).toBe("https://dadosabertos.camara.leg.br/api/v2/blocos?idLegislatura=57&itens=100");
    expect(blocs.map((b) => b.id)).toEqual([584, 585, 586, 587, 588, 589, 590]);
    expect(blocs.find((b) => b.id === 589)).toEqual({
      id: 589, legislature: 57, name: "UNIÃO, PP, PSD, REPUBLICANOS, MDB, Federação PSDB CIDADANIA, PODE", federation: false,
      parties: ["PSDB", "CIDADANIA", "UNIÃO", "PP", "REPUBLICANOS", "PSD", "MDB", "PODE"],
    });
    expect(blocs.find((b) => b.id === 585)).toMatchObject({ federation: true, parties: ["PSDB", "CIDADANIA"] });
    expect(blocs.find((b) => b.id === 590)).toMatchObject({ name: "AVANTE, SOLIDARIEDADE, PRD", parties: [] });
  });

  it("fetchBlocs: a members request that fails fails the whole fetch (the stored blocs are kept by the caller)", async () => {
    const { f } = fakeCamaraMonitorFetch({ "/blocos/589/partidos": { status: 500 } });
    await expect(fetchBlocs(f)).rejects.toThrow();
  });
});
