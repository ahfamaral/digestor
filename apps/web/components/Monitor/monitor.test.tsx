import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { landingHref, parseDeputy, parseDirectory, parseLanding, type LandingParams } from "@/lib/monitor/params";
import { DeputyView } from "./DeputyView";
import { DirectoryView } from "./DirectoryView";
import { formQuery } from "./GetForm";
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
import { SearchedFor } from "./SearchedFor";
import { SpeechItem } from "./SpeechItem";
import { VoteRow } from "./VoteRow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/monitor",
  useSearchParams: () => new URLSearchParams(),
}));

const member = { id: 1, externalId: 999, name: "Suplente Teste", party: "PT", uf: "SP", photoUrl: null, inOffice: false };
const emptyWorkspace = {
  profile: { profession: null, externalMandates: [], fronts: [], positions: [] }, bands: [], presence: null,
  bills: { total: 0, byType: [], rows: [] }, phases: [], today: "2026-11-11",
};

describe("formQuery", () => {
  it("drops empty fields and radios left at their default", () => {
    const entries: [string, string][] = [["rel", "by"], ["q", "saúde pública"], ["exact", "1"], ["from", ""], ["to", ""], ["phase", ""]];
    expect(formQuery(entries, new Set(["rel=by"]))).toBe("q=sa%C3%BAde+p%C3%BAblica&exact=1");
  });
  it("keeps a radio that is not the default, and repeated names", () => {
    expect(formQuery([["rel", "mentions"], ["party", "PT"], ["party", "PL"]], new Set(["rel=by"]))).toBe("rel=mentions&party=PT&party=PL");
  });
  it("is empty when nothing is filled in", () => {
    expect(formQuery([["q", ""]])).toBe("");
  });
});

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
        <VoteRow locale="en" from={204407} vote={{ rollCallId: "2449741-72", date: "2026-03-10", description: "Mantido o texto.", billId: 2449741, billLabel: "PL 2942/2024", billSummary: "Ementa", vote: "Artigo 17" }} />
      </ul>,
    );
    expect(html).toContain(">Artigo 17<");
    expect(html).toContain('href="https://www.camara.leg.br/propostas-legislativas/2449741"');
    // a vote row opens the roll-call page, which then offers the way back to this deputy
    expect(html).toContain('href="/monitor/votacoes/2449741-72?from=204407"');
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

  it("the deputy page lists its sections at the top and pages the votes", () => {
    const vote = (i: number) => ({ rollCallId: `1-${i}`, date: "2026-03-10", description: "Aprovado.", billId: null, billLabel: null, billSummary: "", vote: "Sim" });
    const html = renderToStaticMarkup(
      <DeputyView
        locale="en" member={{ ...member, inOffice: true }} params={parseDeputy({})} searched={null} speeches={{ total: 0, rows: [] }}
        {...emptyWorkspace} profile={{ ...emptyWorkspace.profile, fronts: ["Frente A"] }}
        votes={{ total: 45, rows: Array.from({ length: 20 }, (_, i) => vote(i)) }}
      />,
    );
    const nav = html.slice(html.indexOf('aria-label="On this page"'));
    for (const id of ["speeches", "bills", "votes", "presence", "fronts"]) expect(nav).toContain(`href="#${id}"`);
    expect(html).toContain('id="presence"');
    expect(html).toContain('id="fronts"');
    expect(html).toContain('href="/monitor/deputados/999?vp=1#votes"');
    expect(html).toContain("1–20 of 45");
    // no Fronts link when there are none
    const none = renderToStaticMarkup(
      <DeputyView locale="en" member={member} params={parseDeputy({})} searched={null} speeches={{ total: 0, rows: [] }} votes={{ total: 0, rows: [] }} {...emptyWorkspace} />,
    );
    expect(none).not.toContain('href="#fronts"');
  });

  it("an untranscribed speech says the full text is not published yet", () => {
    const html = renderToStaticMarkup(
      <DeputyView
        locale="en" member={{ ...member, inOffice: true }} params={parseDeputy({})} searched={null} votes={{ total: 0, rows: [] }} {...emptyWorkspace}
        speeches={{ total: 1, rows: [{ id: 1, startsAt: "2026-10-14T20:12", phase: "Breves Comunicações", kind: null, summary: "Resumo.", text: "", urlText: null, textFile: false, video: null }] }}
      />,
    );
    expect(html).toContain("Full text not published yet");
    expect(html).not.toContain("Not in office now");
  });

  const searched = { q: "feminicídio", terms: ["feminicídio"], translatedFrom: null, notice: null, exact: false };
  const hit = {
    id: 7, startsAt: "2026-04-08T11:28", phase: "Comissão Geral", kind: null, summary: "RESUMO OFICIAL", text: "texto",
    urlText: null, textFile: false, video: null, member: { externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS" }, snippet: "o \u0001feminicídio\u0002 no RS", partyThen: "PSOL", ufThen: "RS",
  };

  const facets = { parties: ["PL", "PSOL"], ufs: ["RS", "SP"], phases: ["Breves Comunicações"] };
  const landing = (o: Partial<LandingParams> = {}) => ({ ...parseLanding({}), ...o });
  const rollCall = { id: "2449741-72", date: "2026-07-08", description: "Aprovado o projeto", yes: 300, no: 100, other: 2, billId: 2449741, billLabel: "PL 2942/2024", snippet: "o \u0001projeto\u0002" };

  it("Searched for names the typed words and labels the terms added automatically", () => {
    const more = renderToStaticMarkup(<SearchedFor locale="en" searched={{ ...searched, q: "saúde", terms: ["saúde", "sistema de saúde", "assistência médica"] }} />);
    expect(more).toContain("Searched for: saúde");
    expect(more).toContain("plus related terms added automatically: sistema de saúde, assistência médica");
    const translated = renderToStaticMarkup(<SearchedFor locale="en" searched={{ ...searched, q: "health", terms: ["saúde"], translatedFrom: "health" }} />);
    expect(translated).toContain("Searched for: saúde (from “health”)");
    expect(translated).not.toContain("related terms");
    const exact = renderToStaticMarkup(<SearchedFor locale="pt-BR" searched={{ ...searched, q: "reforma tributária", terms: ["reforma tributária"], exact: true }} />);
    expect(exact).toContain("Buscado exatamente: reforma tributária");
  });

  it("the topic form offers exact words and marks the speech-only filters", () => {
    const html = renderToStaticMarkup(<LandingView locale="en" params={landing({ exact: true })} facets={facets} result={null} />);
    expect(html).toMatch(/<input[^>]*name="exact"[^>]*checked=""[^>]*value="1"/);
    expect(html).toContain("Exact words only");
    expect(html).toContain("Speeches only");
    // the note above roll-call results when speech-only filters are set and only roll calls are shown
    const only = renderToStaticMarkup(
      <LandingView locale="en" params={landing({ q: "saúde", party: "PL", show: { speeches: false, rollCalls: true } })} facets={facets} result={{ ...searched, q: "saúde", speeches: null, rollCalls: { total: 1, rows: [rollCall] } }} />,
    );
    expect(only).toContain("Party, state, phase and “in office” filter speeches only; roll calls ignore them.");
  });

  it("results start with their counts, each jumping to its group", () => {
    const html = renderToStaticMarkup(
      <LandingView locale="en" params={landing({ q: "saúde" })} facets={facets} result={{ ...searched, q: "saúde", speeches: { total: 1556, rows: [] }, rollCalls: { total: 1, rows: [rollCall] } }} />,
    );
    expect(html).toContain('href="#speeches"');
    expect(html).toContain("1,556 speeches");
    expect(html).toContain('href="#rollcalls"');
    expect(html).toContain("1 roll call");
    expect(html).toContain('id="rollcalls"');
  });

  it("an empty topic search says what to type", () => {
    const html = renderToStaticMarkup(<LandingView locale="en" params={landing({ party: "PL" })} facets={facets} result={null} askedEmpty />);
    expect(html).toContain("Type a topic to search; the filters narrow it.");
    expect(renderToStaticMarkup(<LandingView locale="en" params={landing()} facets={facets} result={null} />)).not.toContain("Type a topic to search");
  });

  it("landing links the directory of all deputies under the name box, with the count in office", () => {
    const html = renderToStaticMarkup(<LandingView locale="en" params={landing()} facets={facets} result={null} deputies={513} />);
    expect(html).toContain('href="/monitor/deputados"');
    expect(html).toContain("Browse all deputies (513)");
    const pt = renderToStaticMarkup(<LandingView locale="pt-BR" params={landing()} facets={facets} result={null} deputies={513} />);
    expect(pt).toContain("Ver todos os deputados (513)");
  });

  it("a deputy's page links the directory next to the name box", () => {
    const html = renderToStaticMarkup(
      <DeputyView locale="en" member={member} params={parseDeputy({})} speeches={{ total: 0, rows: [] }} searched={null} votes={{ total: 0, rows: [] }} {...emptyWorkspace} />,
    );
    expect(html).toMatch(/href="\/monitor\/deputados"[^>]*>All deputies</);
  });

  describe("directory", () => {
    const dep = (externalId: number, name: string, party: string, uf: string, inOffice = true) => ({ externalId, name, party, uf, photoUrl: null, inOffice });
    const members = [
      dep(1, "Ana Paula", "PT", "SP"), dep(2, "Átila Lira", "PP", "PI"), dep(3, "Bia Kicis", "PL", "DF"), dep(4, "Bruno Ganem", "PT", "SP", false),
      dep(5, "Zé Silva", "SOLIDARIEDADE", "MG"),
    ];

    it("lists the deputies in office by letter, each linking their page, with a letter row", () => {
      const html = renderToStaticMarkup(<DirectoryView locale="en" params={parseDirectory({})} members={members} />);
      expect(html).toContain("<h1");
      expect(html).toContain("All deputies</h1>");
      expect(html).toContain("4 deputies");
      expect(html).toContain('href="/monitor/deputados/2"');
      expect(html).not.toContain("Bruno Ganem");
      // Átila sits under A, accents ignored
      expect(html.indexOf("Átila Lira")).toBeGreaterThan(html.indexOf('id="letter-A"'));
      expect(html.indexOf("Átila Lira")).toBeLessThan(html.indexOf('id="letter-B"'));
      expect(html).toContain('aria-label="Jump to a letter"');
      expect(html).toContain('href="#letter-Z"');
      expect(html).not.toContain("Clear filters");
      // alphabetical only: nothing about activity
      expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/speech|vote|%|rank/i);
    });

    it("filters by today's party and state, and adds former deputies on request", () => {
      const html = renderToStaticMarkup(<DirectoryView locale="en" params={parseDirectory({ party: "PT", former: "1" })} members={members} />);
      expect(html).toContain("Ana Paula");
      expect(html).toContain("Bruno Ganem");
      expect(html).toContain("Not in office now");
      expect(html).not.toContain("Bia Kicis");
      expect(html).toContain("2 deputies");
      expect(html).toContain('href="/monitor/deputados"');
      expect(html).toContain("Clear filters");
    });

    it("says when nothing matches, in Portuguese too", () => {
      const html = renderToStaticMarkup(<DirectoryView locale="pt-BR" params={parseDirectory({ uf: "AC" })} members={members} />);
      expect(html).toContain("Nenhum deputado corresponde a estes filtros.");
      expect(html).toContain("0 deputados");
      expect(html).not.toContain("Ir para uma letra");
      expect(html).toContain('lang="pt-BR"');
    });
  });

  it("landing without a query shows both doors and no results", () => {
    const html = renderToStaticMarkup(<LandingView locale="en" params={landing()} facets={facets} result={null} />);
    expect(html).toContain("Find a deputy");
    expect(html).toContain("Search a topic across the Câmara");
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain("No speeches match.");
    expect(html).not.toContain("Speeches</h2>");
  });

  it("a speech's summary is labelled as the Câmara's and links to its official text", () => {
    const row = { id: 3, startsAt: "2026-02-24T19:08", phase: "Breves Comunicações", kind: null, summary: "A Deputada denunciou.", text: "A SRA. X - Presidente…", urlText: "https://imagem.camara.gov.br/dc_20b.asp?Datain=25%2F2%2F2026&txPagina=152", textFile: false, video: null };
    const html = renderToStaticMarkup(<ul><SpeechItem locale="en" speech={row} /></ul>);
    expect(html).toContain("Câmara summary");
    expect(html.indexOf("Câmara summary")).toBeLessThan(html.indexOf("A Deputada denunciou."));
    expect(html).toContain('href="https://imagem.camara.gov.br/dc_20b.asp?Datain=25%2F2%2F2026&amp;txPagina=152"');
    expect(html).toContain("Official record");
    expect(renderToStaticMarkup(<ul><SpeechItem locale="pt-BR" speech={row} /></ul>)).toContain("Resumo da Câmara");
    // no link without one
    expect(renderToStaticMarkup(<ul><SpeechItem locale="en" speech={{ ...row, urlText: null }} /></ul>)).not.toContain("Official record");
  });

  it("a speech placed in the session's video offers Watch and a YouTube link, and loads nothing from YouTube before the click", () => {
    const row = {
      id: 5, startsAt: "2026-06-30T14:24", phase: "Breves Comunicações", kind: null, summary: "", text: "O SR. X (PL - RS.) - Quero falar hoje.",
      urlText: null, textFile: false, video: { videoId: "NmI46Y25mEU", startS: 76, endS: 414 },
    };
    const html = renderToStaticMarkup(<ul><SpeechItem locale="en" speech={row} /></ul>);
    expect(html).toContain("Watch the speech (5:38)");
    expect(html).toContain('aria-label="Watch the speech in the session&#x27;s official video, from 0:01:16"');
    expect(html).toContain('href="https://www.youtube.com/watch?v=NmI46Y25mEU&amp;t=76s"');
    expect(html).toContain("Open on YouTube at 0:01:16");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("youtube-nocookie");
    expect(renderToStaticMarkup(<ul><SpeechItem locale="pt-BR" speech={row} /></ul>)).toContain("Ver o discurso (5:38)");
  });

  it("a speech sent in writing says it wasn't spoken; a spoken one without a match says nothing about video", () => {
    const written = {
      id: 6, startsAt: "2026-06-30T13:55", phase: "Encerramento", kind: null, summary: "",
      text: "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO X (SEM REGISTRO TAQUIGRÁFICO). Senhor Presidente…", urlText: null, textFile: false, video: null,
    };
    expect(renderToStaticMarkup(<ul><SpeechItem locale="en" speech={written} /></ul>)).toContain("Sent in writing: not spoken in the session, so there is no video.");
    const spoken = { ...written, text: "O SR. X (PL - RS.) - Presidente…" };
    const html = renderToStaticMarkup(<ul><SpeechItem locale="en" speech={spoken} /></ul>);
    expect(html).not.toContain("Sent in writing");
    expect(html).not.toContain("Watch the speech");
  });

  it("a speech published as an attached file says so instead of showing its text", () => {
    const row = { id: 4, startsAt: "2026-10-13T13:55", phase: "Ordem do Dia", kind: null, summary: "", text: "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO X (SEM REGISTRO TAQUIGRÁFICO).", urlText: "https://imagem.camara.gov.br/x", textFile: true, video: null };
    const html = renderToStaticMarkup(<ul><SpeechItem locale="en" speech={row} /></ul>);
    expect(html).toContain("The Câmara published this speech as an attached file; read it in the official record.");
    expect(html).not.toContain("Show full text");
    expect(html).not.toContain("Full text not published yet");
    expect(html).toContain('href="https://imagem.camara.gov.br/x"');
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
    expect(html).toContain("since Apr 29, 2026");
    // the dates are printed for every width (not hover-only): the list shows on desktop too; the bar is a picture of it
    expect(html).not.toContain("sm:hidden");
    expect(html).toMatch(/<div aria-hidden="true" class="hidden sm:block/);
    expect(html).not.toContain('tabindex="0"');
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
    // Counts read as quantities: in parentheses, on the heading and on each type.
    expect(html).toContain("REQ</abbr> (2)");
    expect(html).toContain("All (3)");
    expect(html).toMatch(/Bills and requests<span[^>]*>\(3\)</);
    // A type filter or a page link lands on the list's heading, not the top of the page.
    expect(html).toContain('href="/monitor/deputados/204407?btype=RCP#bills"');
    expect(html).toContain('id="bills"');
    expect(html.indexOf("Bills and requests")).toBeLessThan(html.indexOf("REQ</abbr> (2)"));
    expect(html).toContain("RCP 1/2026");
    // the codes are explained: their official names on the chips and in a list that works on touch too
    expect(html).toContain('<abbr title="Requerimento"');
    expect(html).toContain("What the codes mean");
    expect(html).toMatch(/RCP<\/dt><dd[^>]*>Requerimento de Instituição de CPI/);
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

  it("a vote row leads with what was voted; the bill summary comes second; a request is marked", () => {
    const v = { rollCallId: "1-1", date: "2026-03-10", description: "Rejeitado o Requerimento.", billId: 1, billLabel: "MPV 1313/2025", billSummary: "Dispõe sobre X", vote: "Não" };
    const html = renderToStaticMarkup(<ul><VoteRow locale="en" vote={v} /></ul>);
    expect(html.indexOf("Rejeitado o Requerimento.")).toBeLessThan(html.indexOf("Dispõe sobre X"));
    expect(html).toMatch(/<p[^>]*text-muted-foreground[^>]*>Dispõe sobre X<\/p>/);
    expect(html).toContain("Vote on a request");
    expect(renderToStaticMarkup(<ul><VoteRow locale="pt-BR" vote={v} /></ul>)).toContain("Votação de requerimento");
    const merit = renderToStaticMarkup(<ul><VoteRow locale="en" vote={{ ...v, description: "Aprovada a Subemenda Substitutiva." }} /></ul>);
    expect(merit).not.toContain("Vote on a request");
    const req = renderToStaticMarkup(<ul><VoteRow locale="en" vote={{ ...v, billLabel: "REQ 4063/2026", description: "Aprovado." }} /></ul>);
    expect(req).toContain("Vote on a request");
  });

  it("roll-call party rows show a chevron, list the smallest vote group first and mark the deputy it was opened from", () => {
    const detail = {
      ...rollCallDetail,
      parties: [{ party: "PL", counts: [{ vote: "Sim", n: 3 }, { vote: "Não", n: 1 }], deputies: [
        { externalId: 1, name: "Ana", uf: "SP", vote: "Sim" }, { externalId: 2, name: "Bia", uf: "SP", vote: "Sim" },
        { externalId: 3, name: "Zé", uf: "RJ", vote: "Não" }, { externalId: 4, name: "Caio", uf: "MG", vote: "Sim" },
      ] }],
    };
    const html = renderToStaticMarkup(<RollCallView locale="en" rollCall={detail} from={2} back={{ href: "/monitor/deputados/2#votes", label: "Bia" }} />);
    expect(html).toContain("lucide-chevron-right");
    const list = html.slice(html.indexOf("By party"));
    expect(list.indexOf(">Zé<")).toBeLessThan(list.indexOf(">Ana<"));
    expect(list.indexOf(">Ana<")).toBeLessThan(list.indexOf(">Bia<"));
    expect(html).toContain('aria-current="true"');
    expect(html).toMatch(/Bia: <span[^>]*>Sim<\/span>/);
    // the party holding that deputy opens by itself
    expect(html).toMatch(/<details[^>]*open=""/);
    // the motion leads the header, the bill summary is secondary
    expect(html.indexOf("Aprovado o projeto.")).toBeLessThan(html.indexOf("Altera a Lei"));
  });

  it("a roll call found by a search leads back to that search", () => {
    const html = renderToStaticMarkup(<ul><RollCallItem locale="en" rollCall={rollCall} back="/monitor?q=sa%C3%BAde" /></ul>);
    expect(html).toContain('href="/monitor/votacoes/2449741-72?back=%2Fmonitor%3Fq%3Dsa%25C3%25BAde"');
    const view = renderToStaticMarkup(<RollCallView locale="en" rollCall={rollCallDetail} back={{ href: "/monitor?q=sa%C3%BAde", label: "Câmara monitor" }} />);
    expect(view).toContain('href="/monitor?q=sa%C3%BAde"');
  });

  it("the back link names the deputy the roll call was opened from, else the monitor", () => {
    const html = renderToStaticMarkup(<RollCallView locale="en" rollCall={rollCallDetail} back={{ href: "/monitor/deputados/204407#votes", label: "Fernanda Melchionna" }} />);
    expect(html).toContain('href="/monitor/deputados/204407#votes"');
    expect(html.indexOf("Fernanda Melchionna")).toBeLessThan(html.indexOf("<h1"));
    expect(html).not.toContain("Câmara monitor");
    const plain = renderToStaticMarkup(<RollCallView locale="en" rollCall={rollCallDetail} />);
    expect(plain).toContain('href="/monitor"');
    expect(plain).toContain("Câmara monitor");
  });

  it('empty guidance reads "No guidance"', () => {
    const html = renderToStaticMarkup(<RollCallView locale="en" rollCall={rollCallDetail} />);
    expect(html).toContain("Party and bloc guidance");
    expect(html).toContain("No guidance");
    const pt = renderToStaticMarkup(<RollCallView locale="pt-BR" rollCall={rollCallDetail} />);
    expect(pt).toContain("Sem orientação");
  });
});
