import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { landingHref, parseDeputy, parseLanding, type LandingParams } from "@/lib/monitor/params";
import { DeputyView } from "./DeputyView";
import { Highlighted } from "./Highlighted";
import { AuthoredBills } from "./AuthoredBills";
import { LandingView } from "./LandingView";
import { PartyTimeline } from "./PartyTimeline";
import { Positions } from "./Positions";
import { Presence } from "./Presence";
import { ProfileLine } from "./ProfileLine";
import { Pager } from "./Pager";
import { RollCallItem } from "./RollCallItem";
import { RollCallView } from "./RollCallView";
import { SpeechItem } from "./SpeechItem";
import { VoteRow } from "./VoteRow";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const member = { id: 1, externalId: 999, name: "Suplente Teste", party: "PT", uf: "SP", photoUrl: null, inOffice: false };
const emptyWorkspace = {
  profile: { profession: null, externalMandates: [], fronts: [], positions: [] }, bands: [], presence: null,
  bills: { total: 0, byType: [], rows: [] }, phases: [], today: "2026-11-11",
};

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
    // a vote row opens the roll-call page
    expect(html).toContain('href="/monitor/votacoes/2449741-72"');
  });

  it("a deputy with no speeches and no votes shows both empty states", () => {
    const html = renderToStaticMarkup(
      <DeputyView locale="en" member={member} params={parseDeputy({})} speeches={{ total: 0, rows: [] }} searched={null} votes={{ total: 0, rows: [] }} {...emptyWorkspace} />,
    );
    expect(html).toContain("No speeches in 2026.");
    expect(html).toContain("No recorded votes in 2026.");
    expect(html).toContain("Not in office now");
    expect(html).toContain('href="https://www.camara.leg.br/deputados/999"');
  });

  it("an untranscribed speech says the full text is not published yet", () => {
    const html = renderToStaticMarkup(
      <DeputyView
        locale="en" member={{ ...member, inOffice: true }} params={parseDeputy({})} searched={null} votes={{ total: 0, rows: [] }} {...emptyWorkspace}
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
    const params = landing({ q: "x", party: "PSOL", p: 2, rp: 1 });
    const html = renderToStaticMarkup(
      <LandingView locale="en" params={params} facets={facets} result={{ ...searched, q: "x", terms: ["x"], rollCalls: { total: 0, rows: [] }, speeches: { total: 0, rows: [] } }} />,
    );
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
      <DeputyView locale="pt-BR" member={member} params={parseDeputy({ q: "femicide" })} searched={null} speeches={{ total: 0, rows: [] }} votes={{ total: 0, rows: [] }} {...emptyWorkspace} searching />,
    );
    expect(deputy).toContain("Buscando…");
    expect(deputy).not.toContain("Nenhum discurso em 2026.");
    expect(deputy).not.toContain("Nenhum voto registrado em 2026.");
  });

  it("the timeline shows UNIÃO then PL and an out-of-office gap with its description", () => {
    const bands = [
      { party: "UNIÃO", uf: "AL", from: "2023-02-01", to: "2025-01-31", inOffice: true, description: "" },
      { party: "UNIÃO", uf: "AL", from: "2025-01-31", to: "2025-02-11", inOffice: false, description: "Saída - Afastamento sem prazo determinado - Secretário de Estado" },
      { party: "UNIÃO", uf: "AL", from: "2025-02-11", to: "2026-04-29", inOffice: true, description: "" },
      { party: "PL", uf: "AL", from: "2026-04-29", to: null, inOffice: true, description: "" },
    ];
    const html = renderToStaticMarkup(<PartyTimeline locale="en" bands={bands} today="2026-11-11" />);
    expect(html.indexOf("UNIÃO")).toBeLessThan(html.indexOf("PL"));
    expect(html).toContain("Secretário de Estado");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("since Apr 29, 2026");
    expect(renderToStaticMarkup(<PartyTimeline locale="en" bands={[]} today="2026-11-11" />)).toBe("");
  });

  it("positions list leading roles first and fold memberships", () => {
    const positions = [
      { body: "CMULHER", bodyName: "Comissão de Defesa dos Direitos da Mulher", title: "Titular", from: "2023-03-15", to: "2023-12-15" },
      { body: "CREDN", bodyName: "Comissão de Relações Exteriores e de Defesa Nacional", title: "Suplente", from: "2026-08-12", to: null },
      { body: "CMULHER", bodyName: "Comissão de Defesa dos Direitos da Mulher", title: "Presidente", from: "2025-03-12", to: null },
    ];
    const html = renderToStaticMarkup(<Positions locale="en" positions={positions} today="2026-11-11" />);
    expect(html.indexOf("Presidente")).toBeLessThan(html.indexOf("Member of 2 committees"));
    expect(html).toContain("<details");
    expect(html).toContain("now");
  });

  it("presence is a record, never a score", () => {
    const presence = { sessions: 81, present: 78, missing: [{ id: 81024, startsAt: "2026-02-11T14:07", description: "Sessão Deliberativa Extraordinária" }] };
    for (const locale of ["en", "pt-BR"] as const) {
      const html = renderToStaticMarkup(<Presence locale={locale} presence={presence} year={2026} />);
      expect(html).not.toContain("%");
      expect(html.toLowerCase()).not.toMatch(/absent|ausente/);
      if (locale === "en") {
        expect(html).toContain("Present at 78 of 81 plenary deliberative sessions while in office (2026)");
        expect(html).toContain("No presence recorded (1)");
        expect(html).toContain("The open data doesn&#x27;t say why: justified absences, leave and missions look the same.");
      }
    }
    expect(renderToStaticMarkup(<Presence locale="en" presence={null} year={2026} />)).toContain("Presence not available for this deputy.");
  });

  it("a mention result highlights the name and shows the speaker", () => {
    const mention = { ...hit, member: { externalId: 1, name: "Outro Deputado", party: "PT", uf: "SP" }, snippet: "a deputada \u0001Fernanda Melchionna\u0002 disse", partyThen: "PT", ufThen: "SP" };
    const html = renderToStaticMarkup(
      <DeputyView
        locale="en" member={{ ...member, externalId: 204407, name: "Fernanda Melchionna" }} params={parseDeputy({ rel: "mentions" })} searched={null}
        speeches={{ total: 1, rows: [mention] }} votes={{ total: 0, rows: [] }} {...emptyWorkspace}
      />,
    );
    expect(html).toContain("Fernanda Melchionna</mark>");
    expect(html).toContain('href="/monitor/deputados/1"');
  });

  it("authored bills show counts by type and mark co-authors", () => {
    const bills = {
      total: 3, byType: [{ type: "REQ", n: 2 }, { type: "RCP", n: 1 }],
      rows: [
        { id: 2600034, type: "RCP", number: 1, year: 2026, summary: "Requer a criação de CPI", presentedAt: "2026-02-02T09:54", firstAuthor: false },
        { id: 2646307, type: "REQ", number: 12, year: 2026, summary: "Requer informações", presentedAt: "2026-09-09T22:16", firstAuthor: true },
      ],
    };
    const html = renderToStaticMarkup(<AuthoredBills locale="en" externalId={204407} params={parseDeputy({})} bills={bills} />);
    expect(html).toContain("REQ 2");
    expect(html).toContain('href="/monitor/deputados/204407?btype=RCP"');
    expect(html.indexOf("Bills and requests")).toBeLessThan(html.indexOf("REQ 2"));
    expect(html).toContain("RCP 1/2026");
    expect(html).toContain("co-author");
    expect(html.match(/co-author/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<AuthoredBills locale="en" externalId={204407} params={parseDeputy({})} bills={{ total: 0, byType: [], rows: [] }} />)).toContain("No bills or requests filed in 2026.");
  });

  it("the profile line merges earlier mandates", () => {
    const html = renderToStaticMarkup(
      <ProfileLine locale="en" profile={{ profession: "Bibliotecária", externalMandates: [{ office: "Vereador(a)", place: "Porto Alegre", uf: "RS", from: 2009, to: 2018, party: "PSOL" }], fronts: [], positions: [] }} />,
    );
    expect(html).toContain("Bibliotecária");
    expect(html).toContain("Vereador(a) · Porto Alegre (RS) · 2009–2018, PSOL");
    const noTown = renderToStaticMarkup(
      <ProfileLine locale="en" profile={{ profession: null, externalMandates: [{ office: "Governador(a)", place: "", uf: "MA", from: 2009, to: 2014, party: "MDB" }], fronts: [], positions: [] }} />,
    );
    expect(noTown).toContain("Governador(a) · MA · 2009–2014, MDB");
  });

  const rollCallDetail = {
    id: "2449741-72", date: "2026-03-10", description: "Aprovado o projeto.", yes: 2, no: 1, other: 0, billId: 2449741, billLabel: "PL 2942/2024",
    billSummary: "Altera a Lei", orientations: [{ bloc: "PL", orientation: "Sim" }, { bloc: "PDT", orientation: "" }],
    parties: [
      { party: "UNIÃO", counts: [{ vote: "Sim", n: 1 }, { vote: "Não", n: 1 }], deputies: [
        { externalId: 220576, name: "Alfredo Gaspar", uf: "AL", vote: "Sim" }, { externalId: 1, name: "Outro", uf: "BA", vote: "Não" },
      ] },
      { party: null, counts: [{ vote: "Sim", n: 1 }], deputies: [{ externalId: 2, name: "Sem Partido", uf: null, vote: "Sim" }] },
    ],
  };

  it("votes are grouped by the party at the vote", () => {
    const html = renderToStaticMarkup(<RollCallView locale="en" rollCall={rollCallDetail} />);
    expect(html).toContain("UNIÃO");
    expect(html).toContain('href="/monitor/deputados/220576"');
    expect(html).toContain("Sim 1 · Não 1");
    expect(html).toContain("No party recorded");
    expect(html).toContain("Party at the time of the vote, as published.");
    expect(html).toContain('href="https://www.camara.leg.br/propostas-legislativas/2449741"');
    expect(html.indexOf("UNIÃO")).toBeLessThan(html.indexOf("Alfredo Gaspar"));
  });

  it('empty guidance reads "No guidance"', () => {
    const html = renderToStaticMarkup(<RollCallView locale="en" rollCall={rollCallDetail} />);
    expect(html).toContain("Party and bloc guidance");
    expect(html).toContain("No guidance");
    const pt = renderToStaticMarkup(<RollCallView locale="pt-BR" rollCall={rollCallDetail} />);
    expect(pt).toContain("Sem orientação");
  });
});
