import { describe, expect, it } from "vitest";
import { suggestRecord } from "./recordSuggest.ts";

type Meta = { title: string; description: string; channel: string; uploadDate: string | null };
const m = (channel: string, title: string, uploadDate: string | null, description = ""): Meta => ({ channel, title, description, uploadDate });

// Real titles, collected 2026-11-04 from the public YouTube channels (yt-dlp --simulate in the worker container).
const pick = (r: ReturnType<typeof suggestRecord>) => r && { chamber: r.chamber, date: "date" in r ? r.date : undefined, sitting: "sitting" in r ? r.sitting : undefined };

describe("suggestRecord: floor sittings", () => {
  it("TV Senado: the title date is DD/M/YY", () => {
    const r = suggestRecord(m("TV Senado", "Sessão Plenária Deliberativa do Senado – 30/6/26", "2026-06-30", "O Plenário do Senado realiza sessão plenária deliberativa."));
    expect(r).toEqual({ chamber: "senado", date: "2026-06-30", sessionCode: null, url: "https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/20260630/20260630" });
  });
  it("TV Senado: other real sittings", () => {
    expect(pick(suggestRecord(m("TV Senado", "Sessão Deliberativa do Plenário – 29/4/26", "2026-04-29")))).toEqual({ chamber: "senado", date: "2026-04-29" });
    expect(pick(suggestRecord(m("TV Senado", "Senado aprova programa de incentivo à produção nacional de fertilizantes – 11/8/26", "2026-08-11")))).toEqual({ chamber: "senado", date: "2026-08-11" });
  });
  it("Câmara dos Deputados: DD/MM/YYYY and the long form with a time", () => {
    expect(pick(suggestRecord(m("Câmara dos Deputados", "Aprovado crédito para motoristas de aplicativo e taxistas - Plenário - 31/8/26", "2026-09-01")))).toEqual({ chamber: "camara", date: "2026-08-31" });
    expect(pick(suggestRecord(m("Câmara dos Deputados", "PLENÁRIO - Sessão Deliberativa - 07/11/2017 - 09:45", "2017-11-07")))).toEqual({ chamber: "camara", date: "2017-11-07" });
    expect(pick(suggestRecord(m("Câmara dos Deputados", "Câmara realiza primeira sessão deliberativa após 2º turno - 27/10/2026 #DiretoDaCâmara", "2026-10-27")))).toEqual({ chamber: "camara", date: "2026-10-27" });
  });
  it("Deutscher Bundestag: 'NN. Sitzung vom DD.MM.YYYY' gives sitting and date", () => {
    const r = suggestRecord(m("Deutscher Bundestag", "92. Sitzung vom 09.09.2026. TOP Epl 04: Bundeskanzler und Bundeskanzleramt", "2026-09-10"));
    expect(r).toEqual({ chamber: "bundestag", period: 21, sitting: 92, date: "2026-09-09", url: "https://www.bundestag.de/services/opendata" });
  });
  it("Deutscher Bundestag: a sitting number alone, with an upload date in period 21", () => {
    const r = suggestRecord(m("Deutscher Bundestag", "103. Sitzung des Bundestages – LIVE", "2026-10-16", "Alle Tagesordnungspunkte gibt es hier: https://www.bundestag.de/parlament/plenum"));
    expect(r).toMatchObject({ chamber: "bundestag", period: 21, sitting: 103, date: null });
  });
  it("a sitting number alone with an upload date outside period 21 gives nothing", () => {
    expect(suggestRecord(m("Deutscher Bundestag", "103. Sitzung des Bundestages – LIVE", "2021-10-16"))).toBeNull();
    expect(suggestRecord(m("Deutscher Bundestag", "103. Sitzung des Bundestages – LIVE", null))).toBeNull();
  });
  it("phoenix with a sitting word: 'NN. Sitzung' and DD.MM.YY", () => {
    const r = suggestRecord(m("phoenix", "Bundestag, 97. Sitzung: Debatte über die Stärkung des Solidarprinzips | 25.09.26", "2026-09-25", "Debatte im Deutschen Bundestag"));
    expect(r).toMatchObject({ chamber: "bundestag", period: 21, sitting: 97, date: "2026-09-25" });
  });
  it("phoenix: the sitting number from the description", () => {
    const r = suggestRecord(m("phoenix", "Regierungsbefragung mit Boris Pistorius und Carsten Linnemann | #Bundestag", "2026-09-23", "Die 95. Sitzung des Deutschen Bundestags beginnt am Mittwoch, 23. September 2026."));
    expect(r).toMatchObject({ chamber: "bundestag", sitting: 95 });
  });
  it("phoenix: 'Bundestagsdebatte' with a date in the title", () => {
    const r = suggestRecord(m("phoenix", "Bundestagsdebatte zur Krankenkassenreform | 10.07.26", "2026-07-10", "Bundestagsdebatte zur Krankenkassenreform"));
    expect(pick(r)).toEqual({ chamber: "bundestag", date: "2026-07-10", sitting: null });
  });
  it("phoenix: 'Bundestag' + 'Debatte' with a long German date", () => {
    const r = suggestRecord(m("phoenix", "Bundestag: Debatte zum Haushalt am 16. Oktober 2026", "2026-10-19"));
    expect(pick(r)).toEqual({ chamber: "bundestag", date: "2026-10-16", sitting: null });
  });
  it("US House Clerk: the date reads 'Monday, November 2, 2026'", () => {
    const r = suggestRecord(m("US House Clerk", "US House Floor Proceedings (Monday, November 2, 2026)", "2026-11-02"));
    expect(r).toEqual({ chamber: "us_house", date: "2026-11-02", url: "https://www.congress.gov/congressional-record/2026/11/02/house-section" });
  });
  it("C-SPAN: 'House Floor' / 'Senate Floor' in the title decides the house", () => {
    expect(pick(suggestRecord(m("C-SPAN", "House Floor, November 4, 2026", "2026-11-05")))).toEqual({ chamber: "us_house", date: "2026-11-04", sitting: undefined });
    expect(pick(suggestRecord(m("C-SPAN", "Senate Floor session 11/4/2026", "2026-11-05")))).toEqual({ chamber: "us_senate", date: "2026-11-04", sitting: undefined });
  });
  it("C-SPAN with 'House session' but both houses named: no guess", () => {
    expect(suggestRecord(m("C-SPAN", "House session and Senate session, November 4, 2026", null))).toBeNull();
  });
});

describe("suggestRecord: single speeches and the upload date", () => {
  it("a single speech on an own channel gives a suggestion from the title date", () => {
    expect(pick(suggestRecord(m("TV Senado", "Teresa Leitão fala da análise da PEC do fim da escala 6x1 – 7/10/26", "2026-10-07")))).toEqual({ chamber: "senado", date: "2026-10-07" });
    expect(pick(suggestRecord(m("TV Senado", "Rogerio Marinho fala sobre pedido de impeachment – 1º/9/26", "2026-09-01")))).toEqual({ chamber: "senado", date: "2026-09-01" });
    expect(pick(suggestRecord(m("Câmara dos Deputados", "Câmara aprova redução de tributos de resseguradoras nacionais - 13/08/2026", "2026-08-13")))).toEqual({ chamber: "camara", date: "2026-08-13" });
  });
  it("a Brazilian description date in long form", () => {
    expect(pick(suggestRecord(m("TV Senado", "Pronunciamento do senador", "2026-10-09", "Discurso feito em 6 de outubro de 2026 no Plenário.")))).toEqual({ chamber: "senado", date: "2026-10-06" });
  });
  it("an own-channel video with only the upload date gives that date", () => {
    expect(pick(suggestRecord(m("TV Senado", "Agenda | Estatuto do Aprendiz", "2026-11-03")))).toEqual({ chamber: "senado", date: "2026-11-03" });
    expect(pick(suggestRecord(m("Deutscher Bundestag", "Annual Tax Act 2026", "2026-11-02")))).toEqual({ chamber: "bundestag", date: "2026-11-02", sitting: null });
  });
  it("a title date beats the upload date", () => {
    expect(pick(suggestRecord(m("TV Senado", "Sessão – 29/4/26", "2026-05-02")))).toEqual({ chamber: "senado", date: "2026-04-29" });
  });
  it("a date from the description when the title has none", () => {
    expect(pick(suggestRecord(m("Deutscher Bundestag", "Rede von Friedrich Merz", "2026-09-20", "Aus der Sitzung vom 09.09.2026")))?.date).toBe("2026-09-09");
  });
  it("a date that does not exist is ignored", () => {
    expect(pick(suggestRecord(m("TV Senado", "Sessão – 31/2/26", "2026-03-02")))).toEqual({ chamber: "senado", date: "2026-03-02" });
  });
});

describe("suggestRecord: no suggestion", () => {
  it("a phoenix interview", () => {
    expect(suggestRecord(m("phoenix", "US-Zwischenwahlen: Stefan Fröhlich über die Auswirkungen auf die US-Zollpolitik | 04.11.26", "2026-11-04"))).toBeNull();
  });
  it("a phoenix video with a sitting week mention is not a sitting word", () => {
    expect(suggestRecord(m("phoenix", "Regierung | 07.10.26", "2026-10-07", "Die Sitzungswoche beginnt am Mittwoch."))).toBeNull();
  });
  it("a C-SPAN hearing and an election-night speech", () => {
    expect(suggestRecord(m("C-SPAN", "Shouting Match at House Oversight Hearing", "2026-01-07", "Rep. James Comer (R-KY): ..."))).toBeNull();
    expect(suggestRecord(m("C-SPAN", "Speaker Johnson Election Night Remarks", "2026-11-04"))).toBeNull();
  });
  it("a news clip from a news channel", () => {
    expect(suggestRecord(m("BILD", "Ordnungsrufe während AfD-Rede: Linken-Abgeordnete Köktürk verlässt den Saal", "2026-09-13"))).toBeNull();
    expect(suggestRecord(m("Portal Uai", "Cleitinho exibe carne no Senado em defesa do fim da escala 6x1 - 28/5/26", "2026-05-28"))).toBeNull();
  });
  it("a broadcaster video with only the upload date", () => {
    expect(suggestRecord(m("phoenix", "Bundestag LIVE: Sitzung", "2026-10-07"))).toBeNull();
    expect(suggestRecord(m("C-SPAN", "House Floor", "2026-10-07"))).toBeNull();
  });
  it("a missing upload date and no date in the text", () => {
    expect(suggestRecord(m("TV Senado", "Agenda", null))).toBeNull();
  });
});
