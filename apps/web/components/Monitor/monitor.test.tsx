import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { landingHref, parseLanding, type LandingParams } from "@/lib/monitor/params";
import { DeputyView } from "./DeputyView";
import { Highlighted } from "./Highlighted";
import { LandingView } from "./LandingView";
import { Pager } from "./Pager";
import { RollCallItem } from "./RollCallItem";
import { SortSwitch } from "./SortSwitch";
import { SpeechItem } from "./SpeechItem";
import { VoteRow } from "./VoteRow";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
    member: { externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS" }, snippet: "o \u0001feminicídio\u0002 no RS", partyThen: "PSOL", ufThen: "RS",
  };

  const facets = { parties: ["PL", "PSOL"], ufs: ["RS", "SP"], phases: ["Breves Comunicações"] };
  const landing = (o: Partial<LandingParams> = {}) => ({ ...parseLanding({}), ...o });
  const rollCall = { id: "2449741-72", date: "2026-07-08", description: "Aprovado o projeto", yes: 300, no: 100, other: 2, billId: 2449741, billLabel: "PL 2942/2024", snippet: "o \u0001projeto\u0002" };

  it("landing without a query shows both doors and no results", () => {
    const html = renderToStaticMarkup(<LandingView locale="en" params={landing()} facets={facets} result={null} />);
    expect(html).toContain("Find a deputy");
    expect(html).toContain("Search a topic across the Câmara");
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain("No speeches match.");
    expect(html).not.toContain("Speeches</h2>");
  });

  it("a speech match shows the highlighted snippet, the party on the day and \"now PL\" when it changed", () => {
    const moved = { ...hit, member: { ...hit.member, party: "PL" }, partyThen: "PSOL", ufThen: "RS" };
    const html = renderToStaticMarkup(
      <LandingView locale="en" params={landing({ q: "feminicídio" })} facets={facets} result={{ ...searched, rollCalls: { total: 0, rows: [] }, speeches: { total: 1, rows: [moved] } }} />,
    );
    expect(html).toContain("feminicídio</mark>");
    expect(html).not.toContain("RESUMO OFICIAL");
    expect(html).toContain('href="/monitor/deputados/204407"');
    expect(html).toContain("PSOL-RS");
    expect(html).toContain("now PL");
    const same = renderToStaticMarkup(<SpeechItem locale="en" speech={hit} showMember />);
    expect(same).toContain("PSOL-RS");
    expect(same).not.toContain("now ");
  });

  it("a roll call opens the roll-call page; the official bill link stays", () => {
    const html = renderToStaticMarkup(<RollCallItem locale="en" rollCall={rollCall} />);
    expect(html).toContain('href="/monitor/votacoes/2449741-72"');
    expect(html).toContain("https://www.camara.leg.br/propostas-legislativas/2449741");
  });

  it("Pager says Previous / Next and keeps the filters", () => {
    const params = landing({ q: "feminicídio", party: "PSOL" });
    const html = renderToStaticMarkup(<Pager locale="en" page={0} size={20} total={45} href={(p) => landingHref({ ...params, p })} />);
    expect(html).toContain("Next");
    expect(html).not.toContain("Previous");
    expect(html).toContain("party=PSOL&amp;p=1");
    const pt = renderToStaticMarkup(<Pager locale="pt-BR" page={1} size={20} total={45} href={(p) => landingHref({ ...params, p })} />);
    expect(pt).toContain("Anterior");
    expect(pt).toContain("Próxima");
  });

  it("only the ticked group is shown; empty states otherwise", () => {
    const only = renderToStaticMarkup(
      <LandingView locale="en" params={landing({ q: "xyz", show: { speeches: true, rollCalls: false } })} facets={facets} result={{ ...searched, q: "xyz", terms: ["xyz"], rollCalls: null, speeches: { total: 0, rows: [] } }} />,
    );
    expect(only).toContain("No speeches match.");
    expect(only).not.toContain("Roll calls</h2>");
    const both = renderToStaticMarkup(
      <LandingView locale="en" params={landing({ q: "xyz" })} facets={facets} result={{ ...searched, q: "xyz", terms: ["xyz"], rollCalls: { total: 0, rows: [] }, speeches: { total: 0, rows: [] } }} />,
    );
    for (const t of ["No speeches match.", "No roll calls match."]) expect(both).toContain(t);
  });

  it("the sort switch keeps every filter and resets the pages", () => {
    const html = renderToStaticMarkup(<SortSwitch locale="en" params={landing({ q: "x", party: "PSOL", p: 2, rp: 1 })} />);
    expect(html).toContain('href="/monitor?q=x&amp;party=PSOL&amp;sort=new"');
    expect(html).toContain('aria-current="true"');
  });

  it("the language switch links back to the same page, and Portuguese labels the page", () => {
    const html = renderToStaticMarkup(<LandingView locale="pt-BR" params={landing({ q: "fêmea" })} facets={facets} result={null} />);
    expect(html).toContain(`href="/monitor/lang?to=en&amp;back=${encodeURIComponent("/monitor?q=f%C3%AAmea")}"`);
    expect(html).toContain("Monitor da Câmara");
    expect(html).toContain('lang="pt-BR"');
  });

  it("while a search runs, both pages say so instead of showing empty lists", () => {
    const search = renderToStaticMarkup(<LandingView locale="en" params={landing({ q: "femicide" })} facets={facets} result={null} searching />);
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
