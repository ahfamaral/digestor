import { describe, expect, it } from "vitest";
import {
  addedDate, bodyChips, bucket, clipCellText, filterRows, filtersToQuery, goTo, needsYou, scopeRows, parseFilters, toExport, typeTabs, whereItIs,
  DEFAULT_FILTERS, type HomeRow,
} from "./home";

const row = (over: Partial<HomeRow> = {}): HomeRow => ({
  id: "x", title: "Mayor interview", language: "en", profile: "interview", stage: "ready", source: "upload", error: null,
  videoRemoved: false, lastActivityAt: "2026-11-06T10:00:00.000Z", createdAt: "2026-11-05T10:00:00.000Z",
  durationMs: 600_000, progress: 100, chamber: null, clipCount: 0, renderedClips: 0, ...over,
});

describe("whereItIs", () => {
  it("names the step a session is at and where its row leads", () => {
    expect(whereItIs(row({ stage: "transcribing", progress: 40 }))).toEqual({ text: "Transcribing · 40%", tone: "busy", href: "/s/x" });
    expect(whereItIs(row({ stage: "awaiting_context" }))).toEqual({ text: "Context check: waiting for you", tone: "waiting", href: "/s/x" });
    expect(whereItIs(row({ clipCount: 3 }))).toEqual({ text: "Prepare", tone: "normal", href: "/s/x/prepare" });
    expect(whereItIs(row())).toEqual({ text: "Briefing ready", tone: "normal", href: "/s/x" });
  });
  it("says Failed and never shows the raw error", () => {
    const w = whereItIs(row({ stage: "failed", error: "ECONNRESET at 10.0.0.1" }));
    expect(w).toEqual({ text: "Failed", tone: "failed", href: "/s/x" });
  });
});

describe("goTo", () => {
  it("links every step of a ready session, Prepare and Export only once it has clips", () => {
    expect(goTo(row())).toEqual([
      { step: "Briefing", href: "/s/x" }, { step: "Prepare", href: null }, { step: "Export", href: null },
    ]);
    expect(goTo(row({ clipCount: 2 }))).toEqual([
      { step: "Briefing", href: "/s/x" }, { step: "Prepare", href: "/s/x/prepare" }, { step: "Export", href: "/s/x/export" },
    ]);
  });
  it("offers the pause or the progress screen before ready, and nothing for a failed session", () => {
    expect(goTo(row({ stage: "awaiting_context" }))).toEqual([{ step: "Context", href: "/s/x" }]);
    expect(goTo(row({ stage: "indexing" }))).toEqual([{ step: "Processing", href: "/s/x" }]);
    expect(goTo(row({ stage: "failed" }))).toEqual([]);
  });
});

describe("toExport and bucket", () => {
  it("counts clips still to export only while the video can still be rendered", () => {
    expect(toExport(row({ clipCount: 3, renderedClips: 1 }))).toBe(true);
    expect(toExport(row({ clipCount: 3, renderedClips: 1, videoRemoved: true }))).toBe(false);
    expect(toExport(row({ clipCount: 3, renderedClips: 3 }))).toBe(false);
    expect(toExport(row({ stage: "failed", clipCount: 3 }))).toBe(false);
  });
  it("puts each session in one status bucket", () => {
    expect(bucket(row())).toBe("ready");
    expect(bucket(row({ stage: "awaiting_context" }))).toBe("needs_you");
    expect(bucket(row({ stage: "failed" }))).toBe("failed");
    expect(bucket(row({ stage: "uploaded", profile: null, durationMs: null, progress: 0 }))).toBe("processing");
  });
});

describe("needsYou", () => {
  it("counts what waits for the journalist", () => {
    const rows = [
      row({ id: "a", stage: "awaiting_context" }),
      row({ id: "b", clipCount: 2, renderedClips: 0 }),
      row({ id: "c", clipCount: 2, renderedClips: 0, videoRemoved: true }),
      row({ id: "d", stage: "failed" }),
      row({ id: "e", stage: "uploaded", profile: null, durationMs: null }),
      row({ id: "f", stage: "writing_briefing" }),
    ];
    expect(needsYou(rows)).toEqual({ needs_you: 1, to_export: 1, failed: 1, processing: 2 });
  });
});

describe("scopeRows", () => {
  it("narrows by the current tab and Body only, so the needs-you counts follow them", () => {
    const rows = [
      row({ id: "a", profile: "parliament", chamber: "camara", stage: "awaiting_context" }),
      row({ id: "b", profile: "parliament", chamber: null, stage: "failed" }),
      row({ id: "c", profile: "interview", stage: "failed" }),
    ];
    const f = { ...DEFAULT_FILTERS, status: "failed" as const, q: "zzz", clips: true, recent: true };
    expect(scopeRows(rows, f).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(needsYou(scopeRows(rows, { ...f, type: "parliament" }))).toMatchObject({ needs_you: 1, failed: 1 });
    expect(scopeRows(rows, { ...f, type: "parliament", body: "unlinked" }).map((r) => r.id)).toEqual(["b"]);
    expect(needsYou(scopeRows(rows, { ...f, type: "interview" }))).toMatchObject({ needs_you: 0, failed: 1 });
  });
});

describe("typeTabs", () => {
  it("lists All first, then only the types present; a session without a type counts in All only", () => {
    const rows = [row({ profile: "parliament" }), row({ profile: "parliament" }), row({ profile: "interview" }), row({ profile: null })];
    expect(typeTabs(rows)).toEqual([
      { id: "all", label: "All", count: 4 },
      { id: "parliament", label: "Parliament", count: 2 },
      { id: "interview", label: "Interview", count: 1 },
    ]);
  });
});

describe("bodyChips", () => {
  it("counts parliament sessions per linked house, and those not linked", () => {
    const rows = [
      row({ profile: "parliament", chamber: "camara" }), row({ profile: "parliament", chamber: "camara" }),
      row({ profile: "parliament", chamber: "bundestag" }), row({ profile: "parliament", chamber: null }),
      row({ profile: "interview", chamber: null }),
    ];
    expect(bodyChips(rows)).toEqual([
      { id: "all", label: "All bodies", count: 4 },
      { id: "camara", label: "Câmara", count: 2 },
      { id: "bundestag", label: "Bundestag (Germany)", count: 1 },
      { id: "unlinked", label: "Not linked", count: 1 },
    ]);
  });
});

describe("filterRows", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const rows = [
    row({ id: "p1", title: "Sessão Plenária Deliberativa", profile: "parliament", chamber: "senado", clipCount: 2 }),
    row({ id: "p2", title: "103. Sitzung", profile: "parliament", chamber: "bundestag", createdAt: "2026-10-28T12:00:00.000Z" }),
    row({ id: "p3", title: "House hearing", profile: "parliament", chamber: null, stage: "failed" }),
    row({ id: "i1", title: "Mayor interview", profile: "interview", clipCount: 1, renderedClips: 1 }),
  ];
  const f = (over: Partial<typeof DEFAULT_FILTERS>) => filterRows(rows, { ...DEFAULT_FILTERS, ...over }, now).map((r) => r.id);
  it("filters by type, body, status, clips and recency", () => {
    expect(f({})).toEqual(["p1", "p2", "p3", "i1"]);
    expect(f({ type: "parliament" })).toEqual(["p1", "p2", "p3"]);
    expect(f({ type: "parliament", body: "unlinked" })).toEqual(["p3"]);
    expect(f({ type: "parliament", body: "senado" })).toEqual(["p1"]);
    expect(f({ status: "failed" })).toEqual(["p3"]);
    expect(f({ status: "to_export" })).toEqual(["p1"]);
    expect(f({ status: "ready" })).toEqual(["p1", "p2", "i1"]);
    expect(f({ clips: true })).toEqual(["p1", "i1"]);
    expect(f({ recent: true })).toEqual(["p1", "p3", "i1"]);
  });
  it("searches titles ignoring case and accents", () => {
    expect(f({ q: "sessao" })).toEqual(["p1"]);
    expect(f({ q: "  SITZUNG " })).toEqual(["p2"]);
  });
});

describe("parseFilters and filtersToQuery", () => {
  it("ignores unknown values", () => {
    expect(parseFilters({ status: "bogus", type: "nope", body: "mars" })).toEqual(DEFAULT_FILTERS);
  });
  it("round-trips, omitting defaults, and keeps a body only on the Parliament tab", () => {
    const f = { ...DEFAULT_FILTERS, type: "parliament" as const, body: "camara" as const, status: "failed" as const, q: "plenária", clips: true, recent: true };
    const q = filtersToQuery(f);
    expect(parseFilters(Object.fromEntries(new URLSearchParams(q)))).toEqual(f);
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe("");
    expect(filtersToQuery({ ...DEFAULT_FILTERS, type: "interview", body: "camara" })).toBe("type=interview");
    expect(parseFilters({ type: "interview", body: "camara" }).body).toBe("all");
  });
});

describe("clipCellText", () => {
  it("summarises a row's clips", () => {
    expect(clipCellText(row({ stage: "transcribing" }))).toBe("—");
    expect(clipCellText(row())).toBe("—");
    expect(clipCellText(row({ clipCount: 8, renderedClips: 1 }))).toBe("8 · 1 rendered");
    expect(clipCellText(row({ clipCount: 1 }))).toBe("1");
  });
});

describe("addedDate", () => {
  it("formats the day in UTC, so server and browser agree near midnight", () => {
    expect(addedDate("2026-11-04T23:30:00.000Z")).toBe("Nov 4");
    expect(addedDate("2026-11-05T00:30:00.000Z")).toBe("Nov 5");
  });
});
