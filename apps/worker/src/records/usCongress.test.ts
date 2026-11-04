import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordRef } from "@digestor/core";
import { MissingApiKeyError } from "../errors.js";
import { findConnector, RecordNotFoundError, RecordNotPublishedError } from "./connector.js";
import { GRANULES_2026_11_02, HOUSE_GRANULE_2024, HOUSE_HTM, HOUSE_MODS, SENATE_GRANULE_2026, SENATE_HTM, SENATE_MODS, fakeUsCongressFetch, stubHtm } from "./fakeUsCongress.js";
import { httpTiming } from "./http.js";
import { parseGranule, parseGranuleMembers, usHouseConnector, usSenateConnector } from "./usCongress.js";

httpTiming.delayMs = 0;

const mods = (members: { id: string; parsed: string; party?: string; state?: string }[]) =>
  `<mods xmlns="http://www.loc.gov/mods/v3"><extension>${members.map((m) => `<congMember bioGuideId="${m.id}" chamber="H" congress="119" party="${m.party ?? "R"}" role="SPEAKING" state="${m.state ?? "TX"}"><name type="parsed">${m.parsed}</name><name type="authority-fnf">First ${m.id}</name></congMember>`).join("")}</extension></mods>`;
const htm = (body: string) => `<html><body><pre>\n[Congressional Record Volume 1, Number 1 (Monday, January 1, 2026)]\n[House]\n[Pages H1-H2]\nFrom the Congressional Record Online through the Government Publishing Office [<a href="https://www.gpo.gov">www.gpo.gov</a>]\n\n${body}\n</pre></body></html>`;

describe("parseGranule (the recorded House granule)", () => {
  const speeches = parseGranule(HOUSE_HTM, HOUSE_MODS);
  it("splits at the labels at line start", () => {
    expect(speeches.length).toBeGreaterThan(40);
    expect(speeches[0]).toMatchObject({ name: "Tom McClintock", officialId: "M001177" });
    expect(speeches.map((s) => s.order)).toEqual(speeches.map((_, i) => i + 1));
    expect(speeches.every((s) => s.textSource === "full" && s.text.length > 0)).toBe(true);
  });
  it("maps Mr. NADLER to N000002 with party and state from the MODS", () => {
    const n = speeches.find((s) => s.officialId === "N000002")!;
    expect(n).toMatchObject({ party: "D", state: "NY", name: "Jerrold Nadler" });
    expect(parseGranuleMembers(HOUSE_HTM, HOUSE_MODS).members["N000002"]).toMatchObject({ displayName: "Jerrold Nadler", party: "D", state: "NY" });
  });
  it("gives the chair no id", () => {
    const chair = speeches.filter((s) => s.name === "The SPEAKER pro tempore");
    expect(chair.length).toBeGreaterThanOrEqual(8);
    expect(chair.every((s) => s.officialId === null && s.party === null)).toBe(true);
    expect(speeches.some((s) => s.name.startsWith("The SPEAKER pro tempore") && s.text.startsWith("All time for debate has expired"))).toBe(true);
  });
  it("keeps page markers, {time} stamps and headings out of the text", () => {
    const all = speeches.map((s) => s.text).join(" ");
    expect(all).not.toMatch(/\[\[Page/);
    expect(all).not.toMatch(/\{time\}/);
    expect(all).not.toMatch(/ANTISEMITISM AWARENESS ACT OF 2023 /);
    expect(speeches.find((s) => s.officialId === "M001177")!.text).toMatch(/^Mr\. Speaker, pursuant to House Resolution 1173/);
  });
  it("decodes the html entities and strips the tags", () => {
    expect(speeches.map((s) => s.text).join(" ")).not.toMatch(/<a |&amp;|&quot;/);
  });
  it("a sentence that only starts with 'The' or 'Mr.' is not a label", () => {
    const s = parseGranule(htm("  Mr. NADLER. Mr. Speaker, hello.\n  The Antisemitism Awareness Act requires this.\n  The IHRA defines it."), mods([{ id: "N1", parsed: "Mr. NADLER" }]));
    expect(s).toHaveLength(1);
    expect(s[0]!.text).toBe("Mr. Speaker, hello. The Antisemitism Awareness Act requires this. The IHRA defines it.");
  });
  it("the Senate's pro forma granule has no speeches", () => {
    expect(parseGranule(SENATE_HTM, SENATE_MODS)).toEqual([]);
  });
});

describe("parseGranule: same surname (Review Focus 3)", () => {
  // The recorded granule has "Mr. SMITH of New Jersey" only; the Texas one is hand-added to its MODS (a copy of the real congMember), as is the second SMITH line.
  const realWithTexas = HOUSE_MODS.replace("</extension>", `<congMember bioGuideId="S999999" chamber="H" congress="118" party="R" role="SPEAKING" state="TX"><name type="parsed">Mr. SMITH of Texas</name><name type="authority-fnf">Adrian Smith-Texas</name></congMember></extension>`);
  const body = "  Mr. SMITH of New Jersey. First.\n  Mr. SMITH of Texas. Second.\n  Mr. SMITH. Bare.\n  Mr. SMITH of Ohio. No match.\n  Mr. NOBODY. Unknown.";
  it("hand-edited copy of the real MODS: each state its own id, bare and unknown labels null", () => {
    expect(realWithTexas).toContain("Mr. SMITH of New Jersey");
    const s = parseGranule(htm(body), realWithTexas);
    expect(s.map((x) => x.officialId)).toEqual(["S000522", "S999999", null, null, null]);
  });
  it("a bare SMITH that matches two parsed names is null; a single bare match is that member", () => {
    const m = mods([{ id: "A", parsed: "Mr. SMITH of Texas" }, { id: "B", parsed: "Mr. SMITH of New Jersey", state: "NJ" }, { id: "C", parsed: "Mr. JONES" }]);
    const s = parseGranule(htm("  Mr. SMITH. one\n  Mr. JONES. two\n  Mr. SMITH of Texas. three"), m);
    expect(s.map((x) => x.officialId)).toEqual([null, "C", "A"]);
    expect(parseGranule(htm("  Mr. SMITH. one"), mods([{ id: "B", parsed: "Mr. SMITH of New Jersey" }]))[0]!.officialId).toBe("B");
  });
  it("a missing or unparsable MODS names no one", () => {
    expect(parseGranule(htm("  Mr. NADLER. Hi."), "<mods/>")[0]).toMatchObject({ officialId: null, name: "Mr. NADLER" });
    expect(parseGranule(htm("  Mr. NADLER. Hi."), "not xml at all")[0]!.officialId).toBeNull();
  });
  it("chair and clerk labels, with or without a presiding member in parentheses", () => {
    const s = parseGranule(htm("  The PRESIDING OFFICER (Mr. LEE). Without objection.\n  The CLERK. The clerk will report.\n  The ACTING PRESIDENT pro tempore. Ok.\n  Ms. McCOLLUM. Thanks."), mods([{ id: "M", parsed: "Mr. LEE" }, { id: "Q", parsed: "Ms. McCOLLUM" }]));
    expect(s.map((x) => [x.name, x.officialId])).toEqual([["The PRESIDING OFFICER", null], ["The CLERK", null], ["The ACTING PRESIDENT pro tempore", null], ["First Q", "Q"]]);
  });
  it("mixed-case surnames (DesJARLAIS, McCLINTOCK, JACKSON LEE)", () => {
    const m = mods([{ id: "D", parsed: "Mr. DesJARLAIS" }, { id: "J", parsed: "Ms. JACKSON LEE" }]);
    expect(parseGranule(htm("  Mr. DesJARLAIS. a\n  Ms. JACKSON LEE. b"), m).map((x) => x.officialId)).toEqual(["D", "J"]);
  });
});

describe("fetchRecord", () => {
  const OLD = process.env.API_DATA_GOV_KEY;
  beforeEach(() => { process.env.API_DATA_GOV_KEY = "test-key"; });
  afterEach(() => { if (OLD === undefined) delete process.env.API_DATA_GOV_KEY; else process.env.API_DATA_GOV_KEY = OLD; });
  const ctx = (now: string) => ({ now: new Date(now), linkedAt: new Date(now) });
  const ref = (chamber: "us_house" | "us_senate", date: string): RecordRef => ({ chamber, date, url: "https://example.com/video" });
  const granule = (cls: string, id: string) => ({ granuleClass: cls, granuleId: id, title: id });
  const list = (granules: unknown[]) => (): Response => new Response(JSON.stringify({ count: granules.length, nextPage: null, granules }), { status: 200 });

  it("is registered for both houses", () => {
    expect(findConnector("us_house")).toBe(usHouseConnector);
    expect(findConnector("us_senate")).toBe(usSenateConnector);
  });

  it("uses only the connector's class, in page order, and never EXTENSIONS or DAILYDIGEST", async () => {
    const ids = ["CREC-2026-01-05-pt1-PgH200", "CREC-2026-01-05-pt1-PgH100", "CREC-2026-01-05-pt1-PgH100-2", "CREC-2026-01-05-pt1-PgS150", "CREC-2026-01-05-pt1-PgE9", "CREC-2026-01-05-pt1-PgD9"];
    const classes = ["HOUSE", "HOUSE", "HOUSE", "SENATE", "EXTENSIONS", "DAILYDIGEST"];
    const { f, calls } = fakeUsCongressFetch({
      list: list(ids.map((id, i) => granule(classes[i]!, id))),
      granule: (id, kind) => (kind === "htm" ? new Response(htm(`  Mr. NADLER. text of ${id}`)) : new Response(mods([{ id: "N1", parsed: "Mr. NADLER" }]))),
    });
    const r = await usHouseConnector.fetchRecord(ref("us_house", "2026-01-05"), f, ctx("2026-02-01T00:00:00Z"));
    expect(r.speeches.map((s) => s.text)).toEqual(["text of CREC-2026-01-05-pt1-PgH100", "text of CREC-2026-01-05-pt1-PgH100-2", "text of CREC-2026-01-05-pt1-PgH200"]);
    expect(r.speeches.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(new Set(r.speeches.map((s) => s.id)).size).toBe(3);
    expect(r.date).toBe("2026-01-05");
    expect(r.members["N1"]).toMatchObject({ displayName: "First N1" });
    expect(calls.some((c) => /PgS150|PgE9|PgD9/.test(c))).toBe(false);
    expect(calls.every((c) => c.includes("api_key=test-key"))).toBe(true);
    expect(calls[0]).toContain("/packages/CREC-2026-01-05/granules?pageSize=1000&offsetMark=*");
  });

  it("the Senate connector takes the Senate granules of the recorded day", async () => {
    const { f, calls } = fakeUsCongressFetch();
    const r = await usSenateConnector.fetchRecord(ref("us_senate", "2026-11-02"), f, ctx("2026-11-04T00:00:00Z"));
    expect(r.speeches).toEqual([]);
    const senateIds = GRANULES_2026_11_02.granules.filter((g) => g.granuleClass === "SENATE").map((g) => g.granuleId);
    expect(senateIds).toContain(SENATE_GRANULE_2026);
    expect(calls.filter((c) => c.endsWith("/htm?api_key=test-key")).length).toBe(senateIds.length);
    expect(calls.some((c) => c.includes("PgH"))).toBe(false);
  });

  it("the House connector reads the recorded House granule with its MODS", async () => {
    const { f } = fakeUsCongressFetch();
    const r = await usHouseConnector.fetchRecord(ref("us_house", "2024-05-01"), f, ctx("2024-06-01T00:00:00Z"));
    expect(r.speeches.find((s) => s.officialId === "N000002")).toBeTruthy();
    expect(r.speeches[0]!.id.startsWith(HOUSE_GRANULE_2024)).toBe(true);
  });

  it("fetches the mods only for granules whose text has a speaker label", async () => {
    const { f, calls } = fakeUsCongressFetch({ list: list([granule("HOUSE", "CREC-2026-01-05-pt1-PgH1")]), granule: (id) => new Response(stubHtm(id)) });
    await usHouseConnector.fetchRecord(ref("us_house", "2026-01-05"), f, ctx("2026-02-01T00:00:00Z"));
    expect(calls.filter((c) => c.includes("/mods"))).toEqual([]);
  });

  it("runs at most 4 granule requests at once", async () => {
    let live = 0;
    let peak = 0;
    const { f } = fakeUsCongressFetch({
      list: list(Array.from({ length: 12 }, (_, i) => granule("HOUSE", `CREC-2026-01-05-pt1-PgH${i + 1}`))),
      granule: async (id, kind) => {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return kind === "htm" ? new Response(htm(`  Mr. NADLER. ${id}`)) : new Response(mods([{ id: "N1", parsed: "Mr. NADLER" }]));
      },
    });
    await usHouseConnector.fetchRecord(ref("us_house", "2026-01-05"), f, ctx("2026-02-01T00:00:00Z"));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("an empty package (what GovInfo answers for a day it has not published) is not published within 3 days, not found after", async () => {
    const { f } = fakeUsCongressFetch();
    await expect(usHouseConnector.fetchRecord(ref("us_house", "2026-11-04"), f, ctx("2026-11-05T00:00:00Z"))).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(usHouseConnector.fetchRecord(ref("us_house", "2026-10-01"), f, ctx("2026-11-05T00:00:00Z"))).rejects.toThrow(new RecordNotFoundError("The House has no record for that date."));
    await expect(usSenateConnector.fetchRecord(ref("us_senate", "2026-10-01"), f, ctx("2026-11-05T00:00:00Z"))).rejects.toThrow("The Senate has no record for that date.");
  });

  it("a 404 on the package: same rule", async () => {
    const { f } = fakeUsCongressFetch({ list: () => new Response("{}", { status: 404 }) });
    await expect(usHouseConnector.fetchRecord(ref("us_house", "2026-11-04"), f, ctx("2026-11-05T00:00:00Z"))).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(usHouseConnector.fetchRecord(ref("us_house", "2026-10-01"), f, ctx("2026-11-05T00:00:00Z"))).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("a package with no granule of this house (the other house sat) is not found, even a day old", async () => {
    const { f } = fakeUsCongressFetch({ list: list([granule("SENATE", "CREC-2026-01-05-pt1-PgS1")]) });
    await expect(usHouseConnector.fetchRecord(ref("us_house", "2026-01-05"), f, ctx("2026-01-06T00:00:00Z"))).rejects.toThrow("The House has no record for that date.");
  });

  it("follows nextPage", async () => {
    const calls: string[] = [];
    const { f } = fakeUsCongressFetch({
      list: (_p, u) => {
        calls.push(u.toString());
        return u.searchParams.get("offsetMark") === "*"
          ? new Response(JSON.stringify({ nextPage: "https://api.govinfo.gov/packages/CREC-2026-01-05/granules?offsetMark=AoE2&pageSize=1000", granules: [granule("HOUSE", "CREC-2026-01-05-pt1-PgH1")] }))
          : new Response(JSON.stringify({ nextPage: null, granules: [granule("HOUSE", "CREC-2026-01-05-pt1-PgH2")] }));
      },
      granule: (id, kind) => (kind === "htm" ? new Response(htm(`  Mr. NADLER. ${id}`)) : new Response(mods([{ id: "N1", parsed: "Mr. NADLER" }]))),
    });
    const r = await usHouseConnector.fetchRecord(ref("us_house", "2026-01-05"), f, ctx("2026-02-01T00:00:00Z"));
    expect(r.speeches).toHaveLength(2);
    expect(calls[1]).toContain("offsetMark=AoE2");
    expect(calls[1]).toContain("api_key=test-key");
  });

  it("a missing key throws MissingApiKeyError before any request", async () => {
    delete process.env.API_DATA_GOV_KEY;
    const { f, calls } = fakeUsCongressFetch();
    const err = await usHouseConnector.fetchRecord(ref("us_house", "2026-11-02"), f, ctx("2026-11-04T00:00:00Z")).catch((e) => e);
    expect(err).toBeInstanceOf(MissingApiKeyError);
    expect(err.message).toBe("API_DATA_GOV_KEY is not set on the server.");
    expect(calls).toEqual([]);
  });

  it("an error never carries the key", async () => {
    const { f } = fakeUsCongressFetch({ list: () => new Response("boom", { status: 403 }) });
    const err = await usHouseConnector.fetchRecord(ref("us_house", "2026-11-02"), f, ctx("2026-11-04T00:00:00Z")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain("test-key");
  });

  it("a ref of another house is refused", async () => {
    const { f } = fakeUsCongressFetch();
    await expect(usHouseConnector.fetchRecord(ref("us_senate", "2026-11-02"), f, ctx("2026-11-04T00:00:00Z"))).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe("stop words", () => {
  it("hold the English fillers and the chair's courtesies", () => {
    for (const w of "the and that this with have for are was were not you your our from they their there which would will been has had speaker madam president gentleman gentlewoman yield time chair".split(" ")) {
      expect(usHouseConnector.stopWords.has(w), w).toBe(true);
      expect(usSenateConnector.stopWords.has(w), w).toBe(true);
    }
  });
  it("speechText is the text", () => {
    expect(usHouseConnector.speechText({ id: "1", order: 1, officialId: null, name: "x", party: null, state: null, text: "hello", textSource: "full" })).toBe("hello");
  });
});
