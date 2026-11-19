import { describe, expect, it } from "vitest";
import {
  activeTopicFilters, askHref, backToSearch, parseAsk, deputyHref, directoryHref, fromDeputy, keptBy, parseDirectory, isRollCallId, landingHref, MONITOR_YEARS, parseDeputy, parseLanding, rollCallHref, yearParam,
  type DeputyParams, type LandingParams,
} from "./params";

const DEFAULT_LANDING: LandingParams = {
  q: "", show: { speeches: true, rollCalls: true }, from: null, to: null, party: null, uf: null, phase: null, inOffice: false,
  sort: "best", year: 2026, p: 0, rp: 0, exact: false,
};

/** A URL's query as Next hands it to a page: repeated keys become arrays. */
function spOf(href: string): Record<string, string | string[]> {
  const sp = new URLSearchParams(href.split("?")[1] ?? "");
  const out: Record<string, string | string[]> = {};
  for (const k of new Set(sp.keys())) {
    const all = sp.getAll(k);
    out[k] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

describe("yearParam", () => {
  it("is always a monitored year", () => {
    expect(MONITOR_YEARS).toEqual([2026]);
    expect(yearParam("2026")).toBe(2026);
    expect(yearParam("1999")).toBe(2026);
    expect(yearParam(undefined)).toBe(2026);
    expect(yearParam(["x", "2026"])).toBe(2026);
  });
});

describe("parseLanding", () => {
  it("defaults", () => {
    expect(parseLanding({})).toEqual(DEFAULT_LANDING);
  });

  it("ignores invalid values", () => {
    expect(parseLanding({ from: "2025-12-31" }).from).toBeNull();
    expect(parseLanding({ to: "2027-01-01" }).to).toBeNull();
    expect(parseLanding({ from: "2026-02-30" }).from).toBeNull();
    expect(parseLanding({ from: "2026-2-3" }).from).toBeNull();
    expect(parseLanding({ party: "';--" }).party).toBeNull();
    expect(parseLanding({ party: "x".repeat(31) }).party).toBeNull();
    expect(parseLanding({ party: "PSOL" }).party).toBe("PSOL");
    expect(parseLanding({ party: "PC do B" }).party).toBe("PC do B");
    expect(parseLanding({ uf: "rs" }).uf).toBeNull();
    expect(parseLanding({ uf: "RSX" }).uf).toBeNull();
    expect(parseLanding({ p: "-1" }).p).toBe(0);
    expect(parseLanding({ rp: "1.5" }).rp).toBe(0);
    expect(parseLanding({ q: ["first", "second"] }).q).toBe("first");
    expect(parseLanding({ party: ["PT", "PL"] }).party).toBe("PT");
    expect(parseLanding({ year: "1999" }).year).toBe(2026);
    expect(parseLanding({ inOffice: "true" }).inOffice).toBe(false);
    expect(parseLanding({ inOffice: "1" }).inOffice).toBe(true);
    expect(parseLanding({ sort: "worst" }).sort).toBe("best");
    expect(parseLanding({ sort: "new" }).sort).toBe("new");
    expect(parseLanding({ phase: "  Breves\u0000 Comunicações " }).phase).toBe("Breves Comunicações");
    expect(parseLanding({ phase: "x".repeat(300) }).phase).toHaveLength(120);
    expect(parseLanding({ phase: "\u0007" }).phase).toBeNull();
    expect(parseLanding({ q: "femi\u0000nicídio" }).q).toBe("femi nicídio");
  });

  it("from after to is swapped", () => {
    expect(parseLanding({ from: "2026-06-01", to: "2026-03-01" })).toMatchObject({ from: "2026-03-01", to: "2026-06-01" });
  });

  it("show with no valid value means both", () => {
    expect(parseLanding({ show: "x" }).show).toEqual({ speeches: true, rollCalls: true });
    expect(parseLanding({ show: "speeches" }).show).toEqual({ speeches: true, rollCalls: false });
    expect(parseLanding({ show: ["rollcalls", "x"] }).show).toEqual({ speeches: false, rollCalls: true });
    expect(parseLanding({ show: ["speeches", "rollcalls"] }).show).toEqual({ speeches: true, rollCalls: true });
  });
});

describe("landingHref", () => {
  it("omits defaults", () => {
    expect(landingHref({})).toBe("/monitor");
    expect(landingHref({ q: "feminicídio" })).toBe("/monitor?q=feminic%C3%ADdio");
  });

  it("round-trips, keys in a fixed order", () => {
    const x: LandingParams = {
      q: "violência contra a mulher", show: { speeches: false, rollCalls: true }, from: "2026-03-01", to: "2026-06-30", party: "PSOL",
      uf: "RS", phase: "Breves Comunicações", inOffice: true, sort: "new", year: 2026, p: 2, rp: 1, exact: true,
    };
    const href = landingHref(x);
    expect([...new URLSearchParams(href.split("?")[1]).keys()]).toEqual([
      "q", "exact", "show", "from", "to", "party", "uf", "phase", "inOffice", "sort", "p", "rp",
    ]);
    expect(parseLanding(spOf(href))).toEqual(x);
    const both = { ...x, show: { speeches: true, rollCalls: true } };
    expect(parseLanding(spOf(landingHref(both)))).toEqual(both);
  });
});

const DEFAULT_DEPUTY: DeputyParams = {
  q: "", rel: "by", from: null, to: null, phase: null, sort: "best", year: 2026, p: 0, btype: null, bp: 0, vp: 0, exact: false,
  bq: "", bexact: false, byear: null, vq: "", vexact: false, vv: null, vk: null, vfrom: null, vto: null, vdiff: false,
  bmeaning: false, vmeaning: false,
};
const FULL_DEPUTY: DeputyParams = {
  q: "Paulão", rel: "mentions", from: "2026-02-01", to: "2026-05-01", phase: "Ordem do Dia", sort: "new", year: 2026, p: 1, btype: "PL", bp: 3, vp: 2,
  exact: true, bq: "violência doméstica", bexact: true, byear: 2025, vq: "reforma tributária", vexact: true, vv: "nao", vk: "request",
  vfrom: "2026-03", vto: "2026-06", vdiff: true, bmeaning: true, vmeaning: true,
};

describe("parseDeputy and deputyHref", () => {
  it("defaults and invalid values", () => {
    expect(parseDeputy({})).toEqual(DEFAULT_DEPUTY);
    expect(parseDeputy({ vp: "2" }).vp).toBe(2);
    expect(parseDeputy({ vp: "x" }).vp).toBe(0);
    expect(parseDeputy({ rel: "x" }).rel).toBe("by");
    expect(parseDeputy({ rel: "mentions" }).rel).toBe("mentions");
    expect(parseDeputy({ btype: "RCP" }).btype).toBe("RCP");
    expect(parseDeputy({ btype: "x".repeat(40) }).btype).toHaveLength(10);
    expect(parseDeputy({ bp: "-3" }).bp).toBe(0);
    expect(parseDeputy({ from: "2026-09-01", to: "2026-02-01" })).toMatchObject({ from: "2026-02-01", to: "2026-09-01" });
  });

  it("vote and bill filters: invalid values are ignored", () => {
    for (const vv of ["sim", "nao", "abstencao", "obstrucao"] as const) expect(parseDeputy({ vv }).vv).toBe(vv);
    for (const vv of ["Sim", "artigo17", "não", "", "1"]) expect(parseDeputy({ vv }).vv).toBeNull();
    expect(parseDeputy({ vk: "bill" }).vk).toBe("bill");
    expect(parseDeputy({ vk: "request" }).vk).toBe("request");
    expect(parseDeputy({ vk: "REQ" }).vk).toBeNull();
    expect(parseDeputy({ vfrom: "2026-03", vto: "2026-12" })).toMatchObject({ vfrom: "2026-03", vto: "2026-12" });
    for (const bad of ["2026-13", "2026-00", "2026-3", "2025-12", "2027-01", "2026-03-01", "x"]) {
      expect(parseDeputy({ vfrom: bad }).vfrom).toBeNull();
      expect(parseDeputy({ vto: bad }).vto).toBeNull();
    }
    // from after to is swapped
    expect(parseDeputy({ vfrom: "2026-09", vto: "2026-02" })).toMatchObject({ vfrom: "2026-02", vto: "2026-09" });
    expect(parseDeputy({ vdiff: "1" }).vdiff).toBe(true);
    expect(parseDeputy({ vdiff: "true" }).vdiff).toBe(false);
    expect(parseDeputy({ vexact: "1", bexact: "1" })).toMatchObject({ vexact: true, bexact: true });
    expect(parseDeputy({ vq: "  reforma\u0000 tributária ", bq: ["saúde", "x"] })).toMatchObject({ vq: "reforma tributária", bq: "saúde" });
    expect(parseDeputy({ vq: "x".repeat(300) }).vq).toHaveLength(200);
    expect(parseDeputy({ vmeaning: "1", bmeaning: "1" })).toMatchObject({ vmeaning: true, bmeaning: true });
    expect(parseDeputy({ vmeaning: "true", bmeaning: "0" })).toMatchObject({ vmeaning: false, bmeaning: false });
    expect(parseDeputy({ byear: "2025" }).byear).toBe(2025);
    for (const bad of ["1899", "3000", "2025.5", "-2025", "abc"]) expect(parseDeputy({ byear: bad }).byear).toBeNull();
  });

  it("deputyHref omits defaults and round-trips, keys in a fixed order", () => {
    expect(deputyHref(204407)).toBe("/monitor/deputados/204407");
    const href = deputyHref(204407, FULL_DEPUTY);
    expect(href.startsWith("/monitor/deputados/204407?q=")).toBe(true);
    expect([...new URLSearchParams(href.split("?")[1]).keys()]).toEqual([
      "q", "exact", "rel", "from", "to", "phase", "sort", "p", "bq", "bexact", "bmeaning", "byear", "btype", "bp", "vq", "vexact", "vmeaning", "vv", "vk", "vfrom", "vto", "vdiff", "vp",
    ]);
    expect(parseDeputy(spOf(href))).toEqual(FULL_DEPUTY);
  });

  it("each section's form keeps the other sections and starts its own list on page 1", () => {
    // the votes form: its own fields come from the form, so they and their page are dropped here
    expect(keptBy("votes", FULL_DEPUTY)).toEqual({ ...FULL_DEPUTY, vq: "", vexact: false, vmeaning: false, vv: null, vk: null, vfrom: null, vto: null, vdiff: false, vp: 0 });
    // the bills form keeps the type picked from the type links, and starts on page 1
    expect(keptBy("bills", FULL_DEPUTY)).toEqual({ ...FULL_DEPUTY, bq: "", bexact: false, bmeaning: false, byear: null, bp: 0 });
    expect(keptBy("speeches", FULL_DEPUTY)).toEqual({ ...FULL_DEPUTY, q: "", exact: false, rel: "by", from: null, to: null, phase: null, p: 0 });
    // a filter submitted from page 3 of the votes lands on page 1
    const next = parseDeputy(spOf(deputyHref(1, { ...keptBy("votes", FULL_DEPUTY), vv: "sim" })));
    expect(next).toMatchObject({ vv: "sim", vp: 0, vdiff: false, bp: 3, p: 1 });
    // "Show the closest by meaning" is kept by the other sections' forms, and dropped by a new search in its own
    expect(keptBy("speeches", FULL_DEPUTY)).toMatchObject({ vmeaning: true, bmeaning: true });
    expect(keptBy("bills", FULL_DEPUTY)).toMatchObject({ vmeaning: true, bmeaning: false });
    expect(keptBy("votes", FULL_DEPUTY)).toMatchObject({ vmeaning: false, bmeaning: true });
  });
});

describe("parseDirectory and directoryHref", () => {
  it("today's party and state, former deputies on request; invalid values ignored", () => {
    expect(parseDirectory({})).toEqual({ party: null, uf: null, former: false });
    expect(parseDirectory({ party: "PC do B", uf: "SP", former: "1" })).toEqual({ party: "PC do B", uf: "SP", former: true });
    expect(parseDirectory({ party: "';--", uf: "sp", former: "true" })).toEqual({ party: null, uf: null, former: false });
    expect(directoryHref()).toBe("/monitor/deputados");
    const x = { party: "PSOL", uf: "RS", former: true };
    expect(directoryHref(x)).toBe("/monitor/deputados?party=PSOL&uf=RS&former=1");
    expect(parseDirectory(spOf(directoryHref(x)))).toEqual(x);
  });
});

describe("roll-call links", () => {
  it("rollCallHref and isRollCallId", () => {
    expect(rollCallHref("2449741-72")).toBe("/monitor/votacoes/2449741-72");
    // opened from a deputy's page: the back link names that deputy
    expect(rollCallHref("2449741-72", { from: 204407 })).toBe("/monitor/votacoes/2449741-72?from=204407");
    // opened from the search results: the way back keeps the search (browsers without the Navigation API too)
    const back = "/monitor?q=sa%C3%BAde&p=2";
    expect(rollCallHref("2449741-72", { back })).toBe(`/monitor/votacoes/2449741-72?back=${encodeURIComponent(back)}`);
    expect(backToSearch({ back })).toBe(back);
    expect(backToSearch({ back: "/monitor" })).toBe("/monitor");
    for (const bad of [undefined, "", "https://evil.example/monitor", "//evil.example", "/monitor/../s/1", "/monitorx", "/monitor?q=a#x", "/s/1", `/monitor?q=${"a".repeat(1200)}`]) {
      expect(backToSearch({ back: bad })).toBeNull();
    }
    expect(fromDeputy({ from: "204407" })).toBe(204407);
    expect(fromDeputy({ from: ["204407", "1"] })).toBe(204407);
    for (const bad of [undefined, "", "0", "-1", "1e3", "abc", "1234567890", "1; drop"]) expect(fromDeputy({ from: bad })).toBeNull();
    expect(isRollCallId("2449741-72")).toBe(true);
    expect(isRollCallId("2449741")).toBe(false);
    expect(isRollCallId("1-1; drop")).toBe(false);
    expect(isRollCallId("1234567890-1")).toBe(false);
    expect(isRollCallId("x")).toBe(false);
    expect(isRollCallId("1-")).toBe(false);
    expect(isRollCallId("../1-1")).toBe(false);
  });
});

describe("parseAsk and askHref", () => {
  it("defaults, and a question cleaned and capped", () => {
    expect(parseAsk({})).toEqual({ q: "", from: null, to: null });
    expect(parseAsk({ q: ["  O que   disseram\u0000 sobre a fome? ", "x"] }).q).toBe("O que disseram sobre a fome?");
    expect(parseAsk({ q: "x".repeat(300) }).q).toHaveLength(200);
  });

  it("ignores invalid dates and swaps a reversed range", () => {
    expect(parseAsk({ from: "2026-02-30", to: "yesterday" })).toMatchObject({ from: null, to: null });
    expect(parseAsk({ from: "2025-12-31", to: "2027-01-01" })).toMatchObject({ from: null, to: null });
    expect(parseAsk({ from: "2026-05-01", to: "2026-03-01" })).toMatchObject({ from: "2026-03-01", to: "2026-05-01" });
  });

  it("builds the page's address with only what is set, and round-trips", () => {
    expect(askHref({})).toBe("/monitor/perguntar");
    const p = { q: "preço da comida", from: "2026-03-01", to: null };
    expect(askHref(p)).toBe("/monitor/perguntar?q=pre%C3%A7o+da+comida&from=2026-03-01");
    expect(parseAsk(spOf(askHref(p)))).toEqual(p);
  });
});

describe("client safety", () => {
  it("params and suggest never import server code (the combobox and year select load them in the browser)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["params.ts", "suggest.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      expect(imports.filter((i) => i === "./search" || i!.includes("/server") || i === "./server"), f).toEqual([]);
    }
  });
});

describe("activeTopicFilters", () => {
  it("counts each filter that narrows the topic search", () => {
    expect(activeTopicFilters(DEFAULT_LANDING)).toBe(0);
    expect(activeTopicFilters({ ...DEFAULT_LANDING, q: "saúde", sort: "new", exact: true, p: 2 })).toBe(0);
    expect(activeTopicFilters({ ...DEFAULT_LANDING, from: "2026-03-01", to: "2026-04-01", party: "PT" })).toBe(3);
    expect(activeTopicFilters({ ...DEFAULT_LANDING, uf: "SP", phase: "Ordem do Dia", inOffice: true })).toBe(3);
    expect(activeTopicFilters({ ...DEFAULT_LANDING, show: { speeches: true, rollCalls: false } })).toBe(1);
  });
});
