import { afterEach, describe, expect, it } from "vitest";
import type { RecordRef } from "@digestor/core";
import { bundestagConnector, parseProtokoll } from "./bundestag.js";
import { findConnector, RecordNotFoundError, RecordNotPublishedError } from "./connector.js";
import { FILTERLIST_EMPTY, FILTERLIST_PAGE1, LISTING_URL_WP21, PROTOKOLL_21103, XML_URL_21103, fakeBundestagFetch } from "./fakeBundestag.js";
import { ApiKeyRejectedError } from "../errors.js";
import { httpTiming } from "./http.js";

httpTiming.delayMs = 0;

const NOW = new Date("2026-11-04T12:00:00Z");
const ctx = { now: NOW, linkedAt: NOW };
const URL_ = "https://www.bundestag.de/services/opendata";
const bySitting = (sitting: number, period = 21): RecordRef => ({ chamber: "bundestag", period, sitting, date: null, url: URL_ });
const byDate = (date: string, period = 21): RecordRef => ({ chamber: "bundestag", period, sitting: null, date, url: URL_ });

afterEach(() => { delete process.env.BUNDESTAG_DIP_API_KEY; });

describe("parseProtokoll", () => {
  const parsed = parseProtokoll(PROTOKOLL_21103);

  it("reads the date from the root's sitzung-datum", () => {
    expect(parsed.date).toBe("2026-10-16");
  });

  it("returns speeches in document order, numbered from 1", () => {
    expect(parsed.speeches.map((s) => s.order)).toEqual(parsed.speeches.map((_, i) => i + 1));
    const named = parsed.speeches.filter((s) => s.officialId).map((s) => s.name);
    expect(named.slice(0, 3)).toEqual(["Michael Thews", "Ulrike Schielke-Ziesing", "Fritz Güntzler"]);
    expect(new Set(parsed.speeches.map((s) => s.id)).size).toBe(parsed.speeches.length);
  });

  it("takes officialId, party and the name from <redner>", () => {
    expect(parsed.speeches.find((s) => s.officialId === "11004424")).toMatchObject({ name: "Michael Thews", party: "SPD", state: null, textSource: "full" });
    expect(parsed.members["11004424"]).toMatchObject({ displayName: "Michael Thews", party: "SPD" });
  });

  it("keeps <kommentar> text out of the speech", () => {
    const thews = parsed.speeches.find((s) => s.officialId === "11004424")!;
    expect(thews.text).toContain("die Frühstartrente");
    expect(thews.text).not.toMatch(/Beifall/);
    expect(parsed.speeches.every((s) => !/Beifall|Zuruf/.test(bundestagConnector.speechText(s)))).toBe(true);
    // the speaker line "Michael Thews (SPD):" is not part of the text either
    expect(thews.text).not.toContain("Michael Thews (SPD):");
  });

  it("makes the president's lines inside a <rede> their own speech with no id (the markup has none)", () => {
    const i = parsed.speeches.findIndex((s) => s.officialId === "11004424");
    const chair = parsed.speeches[i + 1]!;
    expect(chair).toMatchObject({ officialId: null, name: "Präsidentin Julia Klöckner", party: null });
    expect(chair.text).toContain("Ulrike Schielke-Ziesing das Wort");
    // never attributed to the surrounding rede's speaker
    expect(parsed.speeches.find((s) => s.officialId === "11004424")!.text).not.toContain("das Wort. Bitte");
  });

  it("splits a rede where the speaker comes back after the chair's interjection", () => {
    const guntzler = parsed.speeches.filter((s) => s.officialId === "11004285");
    expect(guntzler).toHaveLength(3);
    const chairBetween = parsed.speeches.filter((s) => s.officialId === null && /Redezeit ist abgelaufen|Die Zeit/.test(s.text));
    expect(chairBetween.length).toBeGreaterThanOrEqual(2);
    for (const c of chairBetween) expect(c.officialId).toBeNull();
  });

  it("gives a minister the minister's id and no party; a title is kept out of the name parts' order", () => {
    const bilger = parsed.speeches.find((s) => s.officialId === "11004011")!;
    expect(bilger).toMatchObject({ name: "Steffen Bilger", party: null });
    const hubig = parsed.speeches.find((s) => s.officialId === "999990151")!;
    expect(hubig).toMatchObject({ name: "Dr. Stefanie Hubig", party: null });
    expect(parsed.members["999990151"]).toMatchObject({ displayName: "Dr. Stefanie Hubig", party: null });
    // the minister's speech holds no other speaker's lines
    expect(bilger.text).not.toContain("Präsidentin Julia Klöckner");
  });

  it("gives the vice-president outside any <rede> a null id too, and the opening lines belong to the president", () => {
    expect(parsed.speeches[0]).toMatchObject({ officialId: null, name: "Präsidentin Julia Klöckner" });
    expect(parsed.speeches[0]!.text).toContain("Hiermit ist die Sitzung eröffnet");
    const last = parsed.speeches.at(-1)!;
    expect(last).toMatchObject({ officialId: null, name: "Vizepräsidentin Andrea Lindholz" });
    expect(last.text).toContain("schließe ich jetzt die Aussprache");
  });

  it("throws on XML that is not a Plenarprotokoll", () => {
    expect(() => parseProtokoll("<html><body>Wartungsarbeiten</body></html>")).toThrow(/Plenarprotokoll/);
  });
});

describe("bundestagConnector.findSitting", () => {
  it("finds a sitting by number", async () => {
    const { f } = fakeBundestagFetch();
    expect(await bundestagConnector.findSitting(bySitting(103) as never, f)).toEqual({ xmlUrl: XML_URL_21103, period: 21, sitting: 103, date: "2026-10-16" });
  });

  it("finds the same sitting by date", async () => {
    const { f } = fakeBundestagFetch();
    expect(await bundestagConnector.findSitting(byDate("2026-10-16") as never, f)).toMatchObject({ xmlUrl: XML_URL_21103, sitting: 103 });
  });

  it("pages on until the listing covers an older sitting", async () => {
    const { f, calls } = fakeBundestagFetch();
    const hit = await bundestagConnector.findSitting(bySitting(90) as never, f);
    expect(hit).toMatchObject({ sitting: 90, date: "2026-07-10" });
    expect(calls.filter((c) => c.includes("/ajax/filterlist/")).map((c) => new URL(c).searchParams.get("offset"))).toEqual(["0", "10"]);
    const byD = await bundestagConnector.findSitting(byDate(hit!.date) as never, f);
    expect(byD?.sitting).toBe(90);
  });

  it("returns null for a sitting that is not listed", async () => {
    const { f } = fakeBundestagFetch();
    expect(await bundestagConnector.findSitting(bySitting(104) as never, f)).toBeNull();
    expect(await bundestagConnector.findSitting(bySitting(50) as never, f)).toBeNull();
    expect(await bundestagConnector.findSitting(byDate("2026-10-17") as never, f)).toBeNull();
  });

  it("fails with a plain error naming the listing URL when the page has no parseable links (no silent scraping failure)", async () => {
    const { f } = fakeBundestagFetch({ listing: () => new Response("<html><body>Neue Seite</body></html>", { status: 200 }) });
    const err = await bundestagConnector.findSitting(bySitting(103) as never, f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    expect(err).not.toBeInstanceOf(RecordNotPublishedError);
    expect(err.message).toContain(LISTING_URL_WP21);
  });

  it("fails with a plain error naming the listing on a 5xx", async () => {
    const { f } = fakeBundestagFetch({ listing: () => new Response("x", { status: 503 }) });
    const err = await bundestagConnector.findSitting(bySitting(103) as never, f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(LISTING_URL_WP21);
  });

  it("fails loudly after the page cap instead of looping", async () => {
    const { f, calls } = fakeBundestagFetch({ listing: () => new Response(FILTERLIST_PAGE1, { status: 200 }) });
    const err = await bundestagConnector.findSitting(bySitting(3) as never, f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(LISTING_URL_WP21);
    expect(calls.length).toBeLessThanOrEqual(30);
  });

  it("falls back to the DIP API when the listing fails and a key is set", async () => {
    process.env.BUNDESTAG_DIP_API_KEY = "k-test";
    const { f, calls, dipHeaders } = fakeBundestagFetch({ listing: () => new Response("<html></html>", { status: 200 }) });
    const hit = await bundestagConnector.findSitting(bySitting(103) as never, f);
    expect(hit).toEqual({ xmlUrl: XML_URL_21103, period: 21, sitting: 103, date: "2026-10-16" });
    expect(calls).toContain("https://search.dip.bundestag.de/api/v1/plenarprotokoll?f.dokumentnummer=21/103");
    expect(calls.some((c) => c.includes("apikey"))).toBe(false);
    expect(dipHeaders[0]).toMatchObject({ Authorization: "ApiKey k-test" });
  });

  it("without a DIP key the listing error propagates", async () => {
    const { f, calls } = fakeBundestagFetch({ listing: () => new Response("<html></html>", { status: 200 }) });
    await expect(bundestagConnector.findSitting(bySitting(103) as never, f)).rejects.toThrow(LISTING_URL_WP21);
    expect(calls.some((c) => c.includes("dip.bundestag.de"))).toBe(false);
  });

  it("DIP fallback by date asks for that day", async () => {
    process.env.BUNDESTAG_DIP_API_KEY = "k-test";
    const urls: URL[] = [];
    const { f } = fakeBundestagFetch({
      listing: () => new Response("x", { status: 502 }),
      dip: (u) => { urls.push(u); return new Response(JSON.stringify({ numFound: 1, documents: [{ dokumentnummer: "21/103", datum: "2026-10-16", fundstelle: { xml_url: XML_URL_21103 } }] }), { status: 200 }); },
    });
    const hit = await bundestagConnector.findSitting(byDate("2026-10-16") as never, f);
    expect(hit).toMatchObject({ sitting: 103, date: "2026-10-16" });
    expect(urls[0]!.searchParams.get("f.datum_start")).toBe("2026-10-16");
    expect(urls[0]!.searchParams.get("f.datum_end")).toBe("2026-10-16");
  });
});

describe("DIP key rejected", () => {
  it.each([401, 403])("a DIP %i is a deterministic ApiKeyRejectedError naming the variable", async (status) => {
    process.env.BUNDESTAG_DIP_API_KEY = "bad";
    const { f } = fakeBundestagFetch({ listing: () => new Response("x", { status: 502 }), dip: () => new Response("no", { status }) });
    const err = await bundestagConnector.findSitting(bySitting(103) as never, f).catch((e) => e);
    expect(err).toBeInstanceOf(ApiKeyRejectedError);
    expect(err.message).toBe("The BUNDESTAG_DIP_API_KEY was rejected. Check the key on the server.");
  });
  it("a healthy listing never touches DIP, so a bad key is never noticed", async () => {
    process.env.BUNDESTAG_DIP_API_KEY = "bad";
    const { f, calls } = fakeBundestagFetch();
    await bundestagConnector.findSitting(bySitting(103) as never, f);
    expect(calls.some((c) => c.includes("dip.bundestag.de"))).toBe(false);
  });
});

describe("fix round 1", () => {
  it("a DIP answer whose documents miss fundstelle.xml_url is a plain error naming DIP", async () => {
    process.env.BUNDESTAG_DIP_API_KEY = "k";
    const { f } = fakeBundestagFetch({ listing: () => new Response("x", { status: 502 }), dip: () => new Response(JSON.stringify({ numFound: 1, documents: [{ dokumentnummer: "21/103", datum: "2026-10-16", fundstelle: {} }] })) });
    const err = await bundestagConnector.findSitting(bySitting(103) as never, f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    expect(err.message).toMatch(/DIP.*xml_url/);
  });

  it("an empty first page of a known period is a listing error, not 'not found'", async () => {
    const { f } = fakeBundestagFetch({ listing: () => new Response(FILTERLIST_EMPTY, { status: 200 }) });
    const err = await bundestagConnector.findSitting(bySitting(103, 20) as never, f).catch((e) => e);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    expect(err.message).toContain("/ajax/filterlist/");
  });

  it("an .xml link with an unparseable title fails loudly", async () => {
    const bad = FILTERLIST_PAGE1.replace("Plenarprotokoll der 102. Sitzung von Donnerstag, dem 15. Oktober 2026", "Plenarprotokoll 102 (neu)");
    const { f } = fakeBundestagFetch({ listing: () => new Response(bad, { status: 200 }) });
    const err = await bundestagConnector.findSitting(bySitting(103) as never, f).catch((e) => e);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    expect(err.message).toContain("Plenarprotokoll 102 (neu)");
    expect(err.message).toContain(LISTING_URL_WP21);
  });

  it("decodes numeric entities and keeps all-numeric text as text", () => {
    const xml = `<dbtplenarprotokoll wahlperiode="21" sitzung-nr="1" sitzung-datum="01.01.2026"><sitzungsverlauf><rede id="a"><p klasse="redner"><redner id="1"><name><vorname>A</vorname><nachname>A</nachname><fraktion>SPD</fraktion></name></redner>A A (SPD):</p><p klasse="J_1">Ja &#x2013; nein</p><p klasse="J">1.000</p></rede></sitzungsverlauf></dbtplenarprotokoll>`;
    expect(parseProtokoll(xml).speeches[0]!.text).toBe("Ja \u2013 nein 1.000");
  });

  it("a Zwischenfrage inside a rede keeps every paragraph with its own speaker's id", () => {
    const redner = (id: string, n: string) => `<p klasse="redner"><redner id="${id}"><name><vorname>${n}</vorname><nachname>X</nachname><fraktion>SPD</fraktion></name></redner>${n} X (SPD):</p>`;
    const xml = `<dbtplenarprotokoll wahlperiode="21" sitzung-nr="1" sitzung-datum="01.01.2026"><sitzungsverlauf><rede id="a">${redner("1", "Anna")}<p klasse="J_1">vorher</p>${redner("2", "Boris")}<p klasse="J_1">frage</p>${redner("1", "Anna")}<p klasse="J_1">nachher</p></rede></sitzungsverlauf></dbtplenarprotokoll>`;
    expect(parseProtokoll(xml).speeches.map((s) => [s.officialId, s.text])).toEqual([["1", "vorher"], ["2", "frage"], ["1", "nachher"]]);
  });
});

describe("bundestagConnector.fetchRecord", () => {
  it("is registered for the bundestag", () => {
    expect(findConnector("bundestag")).toBe(bundestagConnector);
  });

  it("returns the speeches, the date, the resolved XML url and the members", async () => {
    const { f } = fakeBundestagFetch();
    const rec = await bundestagConnector.fetchRecord(bySitting(103), f, ctx);
    expect(rec.date).toBe("2026-10-16");
    expect(rec.url).toBe(XML_URL_21103);
    expect(rec.speeches.length).toBeGreaterThan(10);
    expect(Object.keys(rec.members)).toContain("11004424");
  });

  it("a root that disagrees with the ref is a RecordNotFoundError", async () => {
    const wrong = PROTOKOLL_21103.replace('sitzung-nr="103"', 'sitzung-nr="99"');
    const { f } = fakeBundestagFetch({ xml: () => new Response(wrong, { status: 200 }) });
    await expect(bundestagConnector.fetchRecord(bySitting(103), f, ctx)).rejects.toBeInstanceOf(RecordNotFoundError);
    const wrongDate = PROTOKOLL_21103.replace('sitzung-datum="16.10.2026"', 'sitzung-datum="17.10.2026"');
    const g = fakeBundestagFetch({ xml: () => new Response(wrongDate, { status: 200 }) }).f;
    await expect(bundestagConnector.fetchRecord(byDate("2026-10-16"), g, ctx)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("an unparseable protocol is a plain error naming the XML url", async () => {
    const { f } = fakeBundestagFetch({ xml: () => new Response("<html>Wartung</html>", { status: 200 }) });
    const err = await bundestagConnector.fetchRecord(bySitting(103), f, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    expect(err.message).toContain(XML_URL_21103);
  });

  it("a 5xx on the XML is a plain error", async () => {
    const { f } = fakeBundestagFetch({ xml: () => new Response("x", { status: 500 }) });
    const err = await bundestagConnector.fetchRecord(bySitting(103), f, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
  });

  it("a sitting newer than the last listed waits, counted from linkedAt; past the window it is not found", async () => {
    const { f } = fakeBundestagFetch();
    await expect(bundestagConnector.fetchRecord(bySitting(104), f, { now: NOW, linkedAt: new Date("2026-11-03T10:00:00Z") })).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(bundestagConnector.fetchRecord(bySitting(104), f, { now: NOW, linkedAt: new Date("2026-09-01T10:00:00Z") })).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("an older sitting missing from the listing is not found", async () => {
    const { f } = fakeBundestagFetch();
    const err = await bundestagConnector.fetchRecord(bySitting(50), f, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(RecordNotFoundError);
    expect(err.message).toBe("The Bundestag has no record for that sitting.");
  });

  it("a recent date with no sitting waits; an old one is not found", async () => {
    const { f } = fakeBundestagFetch();
    await expect(bundestagConnector.fetchRecord(byDate("2026-10-20"), f, ctx)).rejects.toBeInstanceOf(RecordNotPublishedError); // 15 days ago, newer than 103
    await expect(bundestagConnector.fetchRecord(byDate("2026-11-03"), f, ctx)).rejects.toBeInstanceOf(RecordNotPublishedError);
    const err = await bundestagConnector.fetchRecord(byDate("2026-09-20"), f, ctx).catch((e) => e); // between 91 (8.9.) .. no sitting that day, 45 days ago
    expect(err).toBeInstanceOf(RecordNotFoundError);
    expect(err.message).toBe("The Bundestag has no record for that date.");
  });

  it("a ref of another house is not found", async () => {
    const { f } = fakeBundestagFetch();
    await expect(bundestagConnector.fetchRecord({ chamber: "senado", date: "2026-09-02", sessionCode: null, url: "x" } as never, f, ctx)).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe("bundestagConnector.stopWords", () => {
  it("has the German function words and forms of address", () => {
    const words = "und der die das den dem des ein eine einer nicht mit auf für ist sich auch wir sie ich es zu von im in herr frau präsident präsidentin kollegen kolleginnen damen herren".split(" ");
    for (const w of words) expect(bundestagConnector.stopWords.has(w), w).toBe(true);
  });
  it("also holds the accent-stripped forms (the aligner normalises tokens)", () => {
    expect(bundestagConnector.stopWords.has("fur")).toBe(true);
    expect(bundestagConnector.stopWords.has("prasident")).toBe(true);
  });
});
