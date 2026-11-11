import { describe, expect, it } from "vitest";
import {
  deputyHref, isRollCallId, landingHref, MONITOR_YEARS, parseDeputy, parseLanding, rollCallHref, yearParam, type DeputyParams, type LandingParams,
} from "./params";

const DEFAULT_LANDING: LandingParams = {
  q: "", show: { speeches: true, rollCalls: true }, from: null, to: null, party: null, uf: null, phase: null, inOffice: false,
  sort: "best", year: 2026, p: 0, rp: 0,
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
      uf: "RS", phase: "Breves Comunicações", inOffice: true, sort: "new", year: 2026, p: 2, rp: 1,
    };
    const href = landingHref(x);
    expect([...new URLSearchParams(href.split("?")[1]).keys()]).toEqual([
      "q", "show", "from", "to", "party", "uf", "phase", "inOffice", "sort", "p", "rp",
    ]);
    expect(parseLanding(spOf(href))).toEqual(x);
    const both = { ...x, show: { speeches: true, rollCalls: true } };
    expect(parseLanding(spOf(landingHref(both)))).toEqual(both);
  });
});

describe("parseDeputy and deputyHref", () => {
  it("defaults and invalid values", () => {
    const d: DeputyParams = { q: "", rel: "by", from: null, to: null, phase: null, sort: "best", year: 2026, p: 0, btype: null, bp: 0 };
    expect(parseDeputy({})).toEqual(d);
    expect(parseDeputy({ rel: "x" }).rel).toBe("by");
    expect(parseDeputy({ rel: "mentions" }).rel).toBe("mentions");
    expect(parseDeputy({ btype: "RCP" }).btype).toBe("RCP");
    expect(parseDeputy({ btype: "x".repeat(40) }).btype).toHaveLength(10);
    expect(parseDeputy({ bp: "-3" }).bp).toBe(0);
    expect(parseDeputy({ from: "2026-09-01", to: "2026-02-01" })).toMatchObject({ from: "2026-02-01", to: "2026-09-01" });
  });

  it("deputyHref omits defaults and round-trips", () => {
    expect(deputyHref(204407)).toBe("/monitor/deputados/204407");
    const x: DeputyParams = { q: "Paulão", rel: "mentions", from: "2026-02-01", to: "2026-05-01", phase: "Ordem do Dia", sort: "new", year: 2026, p: 1, btype: "PL", bp: 3 };
    const href = deputyHref(204407, x);
    expect(href.startsWith("/monitor/deputados/204407?q=")).toBe(true);
    expect([...new URLSearchParams(href.split("?")[1]).keys()]).toEqual(["q", "rel", "from", "to", "phase", "sort", "p", "btype", "bp"]);
    expect(parseDeputy(spOf(href))).toEqual(x);
  });
});

describe("roll-call links", () => {
  it("rollCallHref and isRollCallId", () => {
    expect(rollCallHref("2449741-72")).toBe("/monitor/votacoes/2449741-72");
    expect(isRollCallId("2449741-72")).toBe(true);
    expect(isRollCallId("2449741")).toBe(false);
    expect(isRollCallId("1-1; drop")).toBe(false);
    expect(isRollCallId("1234567890-1")).toBe(false);
    expect(isRollCallId("x")).toBe(false);
    expect(isRollCallId("1-")).toBe(false);
    expect(isRollCallId("../1-1")).toBe(false);
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
