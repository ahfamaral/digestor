import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeputyView } from "./DeputyView";
import { Highlighted } from "./Highlighted";
import { VoteRow } from "./VoteRow";
import { SearchView } from "./SearchView";

const member = { id: 1, externalId: 999, name: "Suplente Teste", party: "PT", uf: "SP", photoUrl: null, inOffice: false };

describe("monitor components", () => {
  it("Highlighted marks hits and escapes official text instead of rendering it as HTML", () => {
    const html = renderToStaticMarkup(<Highlighted text={"a \u0001feminicídio\u0002 <b>x</b>"} />);
    expect(html).toContain("<mark");
    expect(html).toContain("feminicídio</mark>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("VoteRow shows the vote label exactly as published", () => {
    const html = renderToStaticMarkup(
      <ul>
        <VoteRow locale="en" vote={{ rollCallId: "2449741-72", date: "2026-03-10", description: "Mantido o texto.", billId: 2449741, billLabel: "PL 2942/2024", billSummary: "Ementa", vote: "Artigo 17" }} />
      </ul>,
    );
    expect(html).toContain(">Artigo 17<");
    expect(html).toContain('href="https://www.camara.leg.br/propostas-legislativas/2449741"');
  });

  it("a deputy with no speeches and no votes shows both empty states", () => {
    const html = renderToStaticMarkup(
      <DeputyView back="/monitor/deputados/999" locale="en" member={member} q="" speeches={{ total: 0, rows: [] }} searched={null} votes={{ total: 0, rows: [] }} page={0} />,
    );
    expect(html).toContain("No speeches in 2026.");
    expect(html).toContain("No recorded votes in 2026.");
    expect(html).toContain("Not in office now");
    expect(html).toContain('href="https://www.camara.leg.br/deputados/999"');
  });

  it("an untranscribed speech says the full text is not published yet", () => {
    const html = renderToStaticMarkup(
      <DeputyView
        back="/monitor/deputados/999" locale="en" member={{ ...member, inOffice: true }} q="" searched={null} page={0} votes={{ total: 0, rows: [] }}
        speeches={{ total: 1, rows: [{ id: 1, startsAt: "2026-10-14T20:12", phase: "Breves Comunicações", kind: null, summary: "Resumo.", text: "" }] }}
      />,
    );
    expect(html).toContain("Full text not published yet");
    expect(html).not.toContain("Not in office now");
  });

  const searched = { q: "feminicídio", terms: ["feminicídio"], translatedFrom: null, notice: null };
  const hit = {
    id: 7, startsAt: "2026-04-08T11:28", phase: "Comissão Geral", kind: null, summary: "RESUMO OFICIAL", text: "texto",
    member: { externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS" }, snippet: "o \u0001feminicídio\u0002 no RS",
  };

  it("a speech match shows the highlighted snippet instead of repeating the summary", () => {
    const html = renderToStaticMarkup(
      <SearchView back="/monitor" locale="en" q="feminicídio" page={0} result={{ ...searched, members: [], rollCalls: [], speeches: { total: 1, rows: [hit] } }} />,
    );
    expect(html).toContain("feminicídio</mark>");
    expect(html).not.toContain("RESUMO OFICIAL");
    expect(html).not.toContain("No deputies match.");
    expect(html).toContain('href="/monitor/deputados/204407"');
  });

  it("a search with no results at all shows every empty state", () => {
    const html = renderToStaticMarkup(
      <SearchView back="/monitor" locale="en" q="xyz" page={0} result={{ ...searched, q: "xyz", terms: ["xyz"], members: [], rollCalls: [], speeches: { total: 0, rows: [] } }} />,
    );
    for (const s of ["No deputies match.", "No speeches match.", "No roll calls match."]) expect(html).toContain(s);
  });

  it("the language switch links back to the same page, and Portuguese labels the page", () => {
    const html = renderToStaticMarkup(<SearchView back="/monitor?q=f%C3%AAmea" locale="pt-BR" q="" page={0} result={null} />);
    expect(html).toContain(`href="/monitor/lang?to=en&amp;back=${encodeURIComponent("/monitor?q=f%C3%AAmea")}"`);
    expect(html).toContain("Monitor da Câmara");
    expect(html).toContain('lang="pt-BR"');
  });

  it("while a search runs, both pages say so instead of showing empty lists", () => {
    const search = renderToStaticMarkup(<SearchView back="/monitor" locale="en" q="femicide" page={0} result={null} searching />);
    expect(search).toContain('role="status"');
    expect(search).toContain("Searching…");
    expect(search).toContain('value="femicide"');
    const deputy = renderToStaticMarkup(
      <DeputyView back="/monitor/deputados/999" locale="pt-BR" member={member} q="femicide" searched={null} page={0} speeches={{ total: 0, rows: [] }} votes={{ total: 0, rows: [] }} searching />,
    );
    expect(deputy).toContain("Buscando…");
    expect(deputy).not.toContain("Nenhum discurso em 2026.");
    expect(deputy).not.toContain("Nenhum voto registrado em 2026.");
  });
});
