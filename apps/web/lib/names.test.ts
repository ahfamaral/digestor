import { describe, expect, it } from "vitest";
import { personAt, exportChecklist, speakersInRange, type Attribution, type Person, type Word } from "@digestor/core";
import { unconfirmedVoices, badgeText, evidenceLine, labelText, momentPeople, rangeVoices, voiceLabel, whosWhoRows, rowRange, confirmBody, anonymousBody, conflictText, rangeFields, scopeFields, voiceConfirmBody, reportTargetId, personDetail, unconfirmedAcrossClips, visibleWhoRows, splitSpeakerQuestions, unconfirmedBannerText, readableRecordDate, type NamesData, type WhosWhoRow } from "./names";

const person = (id: string, displayName: string): Person => ({
  id, displayName, fullName: null, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
});
const att = (o: Partial<Attribution>): Attribution => ({
  id: "a", sessionId: "s", speakerId: "A", startMs: null, endMs: null, personId: "p1", source: "human", status: "confirmed",
  confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(0), supersededAt: null, ...o,
});
const word = (speaker: string, startMs: number, endMs: number): Word => ({ text: "x", startMs, endMs, speaker, confidence: 1 }) as Word;

const persons = [person("p1", "Ana Souza"), person("p2", "Beto Lima")];

describe("badgeText", () => {
  it("matches the spec copy", () => {
    expect(badgeText("record")).toBe("from record");
    expect(badgeText("caption")).toBe("from caption");
    expect(badgeText("transcript")).toBe("from transcript");
    expect(badgeText("metadata")).toBe("from video details");
    expect(badgeText("human")).toBe("from you");
  });
});

describe("voiceLabel", () => {
  it("names a confirmed person with its badge", () => {
    const names: NamesData = { persons, attributions: [att({ personId: "p1", source: "human" })] };
    expect(voiceLabel(names, "A", 1000, false)).toEqual({ text: "Ana Souza", badge: "human", proposed: false });
  });
  it("falls back to Speaker <id> for an unnamed voice", () => {
    expect(voiceLabel({ persons, attributions: [] }, "C", 0, false)).toEqual({ text: "Speaker C", badge: null, proposed: false });
  });
  it("speakerLabel hides unconfirmed names in sensitive profiles", () => {
    const proposed = att({ speakerId: "C", personId: "p1", source: "caption", status: "proposed" });
    expect(voiceLabel({ persons, attributions: [proposed] }, "C", 0, true).text).toBe("Speaker C");
    expect(voiceLabel({ persons, attributions: [proposed] }, "C", 0, false)).toMatchObject({ text: "Ana Souza", proposed: true });
    const confirmed = att({ speakerId: "C", personId: "p1", source: "human", status: "confirmed" });
    expect(voiceLabel({ persons, attributions: [confirmed] }, "C", 0, true).text).toBe("Ana Souza");
  });
});

describe("momentPeople", () => {
  it("lists people in the moment, most speaking time first, without interjections", () => {
    const names: NamesData = {
      persons,
      attributions: [att({ speakerId: "A", personId: "p1" }), att({ id: "b", speakerId: "B", personId: "p2" })],
    };
    const words = [word("B", 0, 4000), word("A", 4000, 14000), word("C", 14000, 15000)];
    const out = momentPeople(names, words, { startMs: 0, endMs: 15000 }, false);
    expect(out.map((p) => [p.speakerId, p.label.text, p.ms])).toEqual([
      ["A", "Ana Souza", 10000],
      ["B", "Beto Lima", 4000],
    ]);
    expect(out[0]!.atMs).toBe(4000);
  });
});

describe("rangeVoices order", () => {
  const names: NamesData = { persons, attributions: [] };

  it("lists voices in the order they first speak in the range, not by speaking time", () => {
    // B opens the exchange, A then speaks longest, B again, C closes (each at least the 3 s that count).
    const words = [word("B", 0, 3000), word("A", 3000, 15000), word("B", 15000, 19000), word("C", 19000, 23000)];
    expect(rangeVoices(names, words, { startMs: 0, endMs: 23000 }, false).map((v) => v.speakerId)).toEqual(["B", "A", "C"]);
    // Inside a range, "first" means first inside it.
    expect(rangeVoices(names, words, { startMs: 3000, endMs: 23000 }, false).map((v) => v.speakerId)).toEqual(["A", "B", "C"]);
  });

  it("a range too short to count any voice lists the fallback by label: A, B, C", () => {
    expect(rangeVoices(names, [], { startMs: 0, endMs: 1000 }, false, ["B", "A", "B"]).map((v) => v.speakerId)).toEqual(["A", "B"]);
  });
});

describe("momentPeople with a ranged name", () => {
  it("lists a voice once per name, each resolved where that name applies", () => {
    const names: NamesData = {
      persons,
      attributions: [att({ speakerId: "A", personId: "p1" }), att({ id: "r", speakerId: "A", personId: "p2", startMs: 5000, endMs: 10000 })],
    };
    const words = [word("A", 0, 4000), word("A", 5000, 9000)];
    const out = momentPeople(names, words, { startMs: 0, endMs: 10000 }, false);
    expect(out.map((p) => [p.speakerId, p.label.text, p.atMs])).toEqual([
      ["A", "Ana Souza", 0],
      ["A", "Beto Lima", 5000],
    ]);
    const v = rangeVoices(names, words, { startMs: 0, endMs: 10000 }, false);
    expect(new Set(v.map((x) => `${x.speakerId}:${x.atMs}`)).size).toBe(2);
    expect(v.map((x) => voiceLabel(names, x.speakerId, x.atMs, false).text)).toEqual(["Ana Souza", "Beto Lima"]);
  });
});

describe("evidenceLine", () => {
  it("says the source and the evidence in one line", () => {
    expect(evidenceLine(att({ source: "human" }))).toBe("From you");
    expect(evidenceLine(att({ source: "caption", evidence: { kind: "caption", frameKey: "f", text: "SEN. ANA", atMs: 5 } }))).toBe(
      "From a caption on screen: “SEN. ANA”",
    );
    expect(evidenceLine(att({ source: "transcript", evidence: { kind: "quote", quote: "I am Ana" } }))).toBe("From the transcript: “I am Ana”");
    expect(evidenceLine(att({ source: "metadata", evidence: { kind: "quote", quote: "Ana Souza interview" } }))).toBe(
      "From the video details: “Ana Souza interview”",
    );
    expect(
      evidenceLine(att({ source: "record", evidence: { kind: "record", speechId: "12", score: 0.91, url: "u", fetchedAt: "2026-11-04" } })),
    ).toBe("From the official record: speech 12, 0.91 match");
  });
});

describe("whosWhoRows", () => {
  // A speaks 0-20 s (one long turn), B 20-30 s, A 30-100 s, B 100-110 s (named differently), C 110-112 s.
  const run = (speaker: string, from: number, to: number): Word[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => word(speaker, from + i * 1000, from + (i + 1) * 1000));
  const words = [...run("A", 0, 20_000), ...run("B", 20_000, 30_000), ...run("A", 30_000, 100_000), ...run("B", 100_000, 110_000), ...run("C", 110_000, 112_000)];

  it("splits a voice the record named as two people", () => {
    const names: NamesData = {
      persons,
      attributions: [
        att({ id: "1", speakerId: "B", personId: "p1" }),
        att({ id: "2", speakerId: "B", personId: "p2", startMs: 100_000, endMs: 110_000 }),
      ],
    };
    const rows = whosWhoRows(names, words).filter((r) => r.speakerId === "B");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.resolution.kind === "named" && r.resolution.personId).sort()).toEqual(["p1", "p2"]);
    expect(rows.find((r) => r.resolution.kind === "named" && r.resolution.personId === "p2")?.sampleStartMs).toBe(100_000);
  });
  it("sorts by speaking time and samples the first turn of 8 s or more", () => {
    const rows = whosWhoRows({ persons, attributions: [] }, words);
    expect(rows.map((r) => r.speakerId)).toEqual(["A", "B", "C"]);
    expect(rows[0]).toMatchObject({ ms: 90_000, sampleStartMs: 0 });
    expect(rows[1]!.ms).toBe(20_000);
    expect(rows[2]).toMatchObject({ sampleStartMs: 110_000 });
  });
  it("marks voices under 10% as not main", () => {
    const rows = whosWhoRows({ persons, attributions: [] }, words);
    expect(rows.map((r) => r.main)).toEqual([true, true, false]);
    expect(rows[2]!.share).toBeCloseTo(2 / 112);
  });
  it("samples the first word when no turn is long enough", () => {
    const short = [...run("A", 0, 3_000), ...run("B", 3_000, 5_000), ...run("A", 5_000, 7_000)];
    expect(whosWhoRows({ persons, attributions: [] }, short).find((r) => r.speakerId === "A")!.sampleStartMs).toBe(0);
  });
});

describe("whosWhoRows conflicts and ranged rows", () => {
  const run = (speaker: string, from: number, to: number): Word[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => word(speaker, from + i * 1000, from + (i + 1) * 1000));
  const words = [...run("C", 0, 10_000), ...run("C", 10_000, 30_000)];
  const proposedAtt = (id: string, personId: string, source: Attribution["source"]) =>
    att({ id, speakerId: "C", personId, source, status: "proposed", startMs: 0, endMs: 10_000 });

  it("keeps a conflict apart from an unnamed stretch of the same voice and explains it", () => {
    const names: NamesData = { persons, attributions: [proposedAtt("1", "p1", "caption"), proposedAtt("2", "p2", "transcript")] };
    const rows = whosWhoRows(names, words);
    expect(rows.map((r) => r.resolution.kind).sort()).toEqual(["conflict", "unnamed"]);
    const conflict = rows.find((r) => r.resolution.kind === "conflict")!;
    expect(conflictText(conflict, names)).toBe("Caption says Ana Souza · Transcript says Beto Lima");
    expect(confirmBody(conflict)).toBeNull();
  });

  it("a ranged row confirms and un-names with its own range; a whole-voice row does not", () => {
    const ranged = whosWhoRows({ persons, attributions: [proposedAtt("1", "p1", "caption")] }, words).find((r) => r.resolution.kind === "named")!;
    expect(rowRange(ranged)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(confirmBody(ranged)).toEqual({ action: "assign", speakerId: "C", personId: "p1", startMs: 0, endMs: 10_000 });
    expect(anonymousBody(ranged)).toEqual({ action: "anonymous", speakerId: "C", startMs: 0, endMs: 10_000 });

    const whole = whosWhoRows({ persons, attributions: [att({ speakerId: "C", personId: "p1", source: "caption", status: "proposed" })] }, words)[0]!;
    expect(rowRange(whole)).toBeNull();
    expect(confirmBody(whole)).toEqual({ action: "confirm", speakerId: "C" });
    expect(anonymousBody(whole)).toEqual({ action: "anonymous", speakerId: "C" });
  });
});

describe("unconfirmedVoices", () => {
  it("gives a ranged proposal its own range and an assign body; a whole-voice one a plain confirm", () => {
    const words = [word("C", 0, 10_000), word("C", 10_000, 20_000)];
    const ranged: NamesData = { persons, attributions: [att({ speakerId: "C", personId: "p1", source: "caption", status: "proposed", startMs: 0, endMs: 10_000 })] };
    const [first, second] = unconfirmedVoices(ranged, words, { startMs: 0, endMs: 20_000 }, false);
    expect(first).toMatchObject({ speakerId: "C", range: { startMs: 0, endMs: 10_000 }, confirm: { action: "assign", speakerId: "C", personId: "p1", startMs: 0, endMs: 10_000 } });
    expect(second).toMatchObject({ range: { startMs: 10_000, endMs: 20_000 }, confirm: null }); // the unnamed rest of the voice: named by its own span, never as a whole voice
    const whole: NamesData = { persons, attributions: [att({ speakerId: "C", personId: "p1", source: "caption", status: "proposed" })] };
    expect(unconfirmedVoices(whole, words, { startMs: 0, endMs: 20_000 }, false)).toMatchObject([{ range: null, confirm: { action: "confirm", speakerId: "C" } }]);
  });
});

describe("unconfirmedVoices and the export check agree", () => {
  it("a voice with 2 s proposed and 2 s unnamed fails the check and lists both parts", () => {
    const words = [word("C", 0, 2_000), word("C", 2_000, 4_000)];
    const r = { startMs: 0, endMs: 4_000 };
    const names: NamesData = { persons, attributions: [att({ speakerId: "C", personId: "p1", source: "caption", status: "proposed", startMs: 0, endMs: 2_000 })] };
    const clip = { ...r, credit: "x", noCreditNeeded: false, warningsAck: true, protectedAck: false };
    const item = exportChecklist({ clip, moment: null, tracks: [], profile: "interview", speakers: speakersInRange(words, names.attributions, r) }).find((i) => i.id === "speaker");
    expect(item?.ok).toBe(false);
    const listed = unconfirmedVoices(names, words, r, false);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ speakerId: "C", confirm: { action: "assign", speakerId: "C", personId: "p1", startMs: 0, endMs: 2_000 } });
    // a voice with only 2 s in total is ignored by both
    expect(unconfirmedVoices(names, [word("C", 0, 2_000)], r, false)).toEqual([]);
  });
});

describe("labelText", () => {
  it("adds the source badge to a proposed name on plain-text surfaces", () => {
    expect(labelText({ text: "Ana Souza", badge: "caption", proposed: true })).toBe("Ana Souza (from caption)");
    expect(labelText({ text: "Ana Souza", badge: "human", proposed: false })).toBe("Ana Souza");
    expect(labelText({ text: "Speaker C", badge: null, proposed: false })).toBe("Speaker C");
    const names: NamesData = { persons, attributions: [att({ speakerId: "C", personId: "p1", source: "transcript", status: "proposed" })] };
    expect(labelText(voiceLabel(names, "C", 0, false))).toBe("Ana Souza (from transcript)");
  });
});

describe("a person with several record turns in one voice (Who's who rows act on all of them)", () => {
  const run = (speaker: string, from: number, to: number): Word[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => word(speaker, from + i * 1000, from + (i + 1) * 1000));
  // Voice A: p1 at 0-10 s, p2 at 10-20 s, p1 again at 20-30 s, p1 again at 30-40 s.
  const words = [...run("A", 0, 40_000)];
  const rec = (id: string, personId: string, startMs: number, endMs: number) =>
    att({ id, speakerId: "A", personId, source: "record", status: "proposed", startMs, endMs });
  const names: NamesData = {
    persons,
    attributions: [rec("1", "p1", 0, 10_000), rec("2", "p2", 10_000, 20_000), rec("3", "p1", 20_000, 30_000), rec("4", "p1", 30_000, 40_000)],
  };
  const rows = whosWhoRows(names, words);
  const p1 = rows.find((r) => r.resolution.kind === "named" && r.resolution.personId === "p1")!;
  const p2 = rows.find((r) => r.resolution.kind === "named" && r.resolution.personId === "p2")!;

  it("one row per person with every range of that person", () => {
    expect(rows).toHaveLength(2);
    expect(p1.ranges).toEqual([{ startMs: 0, endMs: 10_000 }, { startMs: 20_000, endMs: 30_000 }, { startMs: 30_000, endMs: 40_000 }]);
    expect(p2.ranges).toEqual([{ startMs: 10_000, endMs: 20_000 }]);
  });
  it("Confirm and No name send all ranges (one range keeps the single form)", () => {
    expect(confirmBody(p1)).toEqual({
      action: "assign", speakerId: "A", personId: "p1",
      ranges: [{ startMs: 0, endMs: 10_000 }, { startMs: 20_000, endMs: 30_000 }, { startMs: 30_000, endMs: 40_000 }],
    });
    expect(anonymousBody(p1)).toEqual({
      action: "anonymous", speakerId: "A",
      ranges: [{ startMs: 0, endMs: 10_000 }, { startMs: 20_000, endMs: 30_000 }, { startMs: 30_000, endMs: 40_000 }],
    });
    expect(confirmBody(p2)).toEqual({ action: "assign", speakerId: "A", personId: "p2", startMs: 10_000, endMs: 20_000 });
    expect(anonymousBody(p2)).toEqual({ action: "anonymous", speakerId: "A", startMs: 10_000, endMs: 20_000 });
  });
  it("a whole-voice row has no ranges", () => {
    const whole = whosWhoRows({ persons, attributions: [att({ speakerId: "A", personId: "p1", source: "caption", status: "proposed" })] }, words);
    expect(whole[0]!.ranges).toEqual([]);
    expect(confirmBody(whole[0]!)).toEqual({ action: "confirm", speakerId: "A" });
  });
});

describe("evidenceLine for the record", () => {
  const a = att({
    source: "record", status: "proposed",
    evidence: { kind: "record", speechId: "77", score: 0.91, url: "https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/20261021/20261021", fetchedAt: "2026-11-03T10:00:00.000Z" },
  });
  it("names the Senado and the date of the record", () => {
    expect(evidenceLine(a)).toBe("From the Senado record of 21/10/2026: speech 77, 0.91 match");
  });
  it("names the Câmara for a Câmara event link", () => {
    const c = att({ source: "record", status: "proposed", evidence: { kind: "record", speechId: "74848-2026-06-30T19:32-0", score: 0.91, url: "https://www.camara.leg.br/evento-legislativo/82635", fetchedAt: "2026-11-03T10:00:00.000Z" } });
    expect(evidenceLine(c)).toBe("From the Câmara record: speech at 19:32, 0.91 match");
  });
  it("names the house and day of a record evidence that carries them", () => {
    const b = att({ source: "record", status: "proposed", evidence: { kind: "record", speechId: "12", score: 0.81, url: "https://www.bundestag.de/x", fetchedAt: "2026-11-03T10:00:00.000Z", chamber: "bundestag", date: "2026-10-16" } });
    expect(evidenceLine(b)).toBe("From the Bundestag record of 16/10/2026: speech 12, 0.81 match");
  });
  it("shows a US record's day as MM/DD/YYYY", () => {
    const h = att({ source: "record", status: "proposed", evidence: { kind: "record", speechId: "12", score: 0.81, url: "https://www.congress.gov/x", fetchedAt: "2026-11-03T10:00:00.000Z", chamber: "us_house", date: "2026-10-16" } });
    expect(evidenceLine(h)).toBe("From the House record of 10/16/2026: speech 12, 0.81 match");
  });
  it("keeps the Brazilian lines when the evidence also carries chamber and date", () => {
    expect(evidenceLine({ ...a, evidence: { ...(a.evidence as object), chamber: "senado", date: "2026-10-21" } as Attribution["evidence"] })).toBe("From the Senado record of 21/10/2026: speech 77, 0.91 match");
  });
  it("falls back when the url carries no date", () => {
    expect(evidenceLine({ ...a, evidence: { ...(a.evidence as object), url: "https://x" } as Attribution["evidence"] })).toBe("From the official record: speech 77, 0.91 match");
  });
});

describe("the unnamed part of a voice named part by part from the record", () => {
  const run = (speaker: string, from: number, to: number): Word[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => word(speaker, from + i * 1000, from + (i + 1) * 1000));
  // A: record p1 0-10 s, unnamed 10-20 s, B speaks 20-30 s, A unnamed again 30-40 s, record p2 40-50 s.
  const words = [...run("A", 0, 20_000), ...run("B", 20_000, 30_000), ...run("A", 30_000, 50_000)];
  const rec = (id: string, personId: string, startMs: number, endMs: number) =>
    att({ id, speakerId: "A", personId, source: "record", status: "proposed", startMs, endMs });
  const names: NamesData = { persons, attributions: [rec("1", "p1", 0, 10_000), rec("2", "p2", 40_000, 50_000)] };
  const remainder = whosWhoRows(names, words).find((r) => r.speakerId === "A" && r.resolution.kind === "unnamed")!;

  it("gives the remainder row its contiguous spans", () => {
    expect(remainder.ranges).toEqual([{ startMs: 10_000, endMs: 20_000 }, { startMs: 30_000, endMs: 40_000 }]);
  });
  it("Change… and No name send ranges for it", () => {
    expect(anonymousBody(remainder)).toEqual({ action: "anonymous", speakerId: "A", ranges: remainder.ranges });
    expect(rangeFields(remainder.ranges)).toEqual({ ranges: remainder.ranges });
  });
  it("a voice with no ranged rows keeps whole-voice rows", () => {
    const plain = whosWhoRows({ persons, attributions: [] }, words).find((r) => r.speakerId === "A")!;
    expect(plain.ranges).toEqual([]);
  });
  it("the export check offers the unnamed spans of the clip's range, not a whole-voice change", () => {
    const v = unconfirmedVoices(names, words, { startMs: 12_000, endMs: 18_000 }, false).find((x) => x.speakerId === "A")!;
    expect(v.ranges).toEqual([{ startMs: 10_000, endMs: 20_000 }]);
    expect(v.range).toEqual({ startMs: 10_000, endMs: 20_000 });
  });
});

describe("final review: one-span remainder, mixed confirmed/proposed rows, default Confirm", () => {
  const run = (speaker: string, from: number, to: number): Word[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => word(speaker, from + i * 1000, from + (i + 1) * 1000));
  it("a remainder with a single span still sends its range (Change… and No name)", () => {
    const words = run("A", 0, 20_000);
    const names: NamesData = { persons, attributions: [att({ id: "1", speakerId: "A", personId: "p1", source: "record", status: "proposed", startMs: 0, endMs: 10_000 })] };
    const rest = whosWhoRows(names, words).find((r) => r.resolution.kind === "unnamed")!;
    expect(rest.ranges).toEqual([{ startMs: 10_000, endMs: 20_000 }]);
    expect(rowRange(rest)).toBeNull();
    expect(scopeFields(rest.ranges, rowRange(rest) ?? undefined)).toEqual({ startMs: 10_000, endMs: 20_000 });
    expect(anonymousBody(rest)).toEqual({ action: "anonymous", speakerId: "A", startMs: 10_000, endMs: 20_000 });
    expect(scopeFields([], undefined)).toEqual({});
  });
  it("a person with one confirmed and two proposed turns is one unconfirmed row; Confirm writes the proposed ranges only", () => {
    const words = run("A", 0, 30_000);
    const a = (id: string, s: number, e: number, status: Attribution["status"]) =>
      att({ id, speakerId: "A", personId: "p1", source: "record", status, startMs: s, endMs: e });
    const names: NamesData = { persons, attributions: [a("1", 0, 10_000, "confirmed"), a("2", 10_000, 20_000, "proposed"), a("3", 20_000, 30_000, "proposed")] };
    const rows = whosWhoRows(names, words);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolution).toMatchObject({ kind: "named", confirmed: false });
    expect(confirmBody(rows[0]!)).toEqual({
      action: "assign", speakerId: "A", personId: "p1", ranges: [{ startMs: 10_000, endMs: 20_000 }, { startMs: 20_000, endMs: 30_000 }],
    });
  });
  it("the export check lists all of a person's proposed turns that touch the clip", () => {
    const words = run("A", 0, 30_000);
    const a = (id: string, s: number, e: number) => att({ id, speakerId: "A", personId: "p1", source: "record", status: "proposed", startMs: s, endMs: e });
    const names: NamesData = { persons, attributions: [a("1", 0, 10_000), a("2", 10_000, 20_000), a("3", 20_000, 30_000)] };
    const v = unconfirmedVoices(names, words, { startMs: 5_000, endMs: 25_000 }, false);
    expect(v).toHaveLength(1);
    expect(v[0]!.ranges).toEqual([{ startMs: 0, endMs: 10_000 }, { startMs: 10_000, endMs: 20_000 }, { startMs: 20_000, endMs: 30_000 }]);
    expect(v[0]!.confirm).toMatchObject({ action: "assign", ranges: v[0]!.ranges });
  });
});

describe("Confirm from a moment row (SpeakerName's default body)", () => {
  it("a record-proposed ranged name confirms as a ranged assignment, never a whole-voice confirm", () => {
    const a = att({ id: "1", speakerId: "A", personId: "p1", source: "record", status: "proposed", startMs: 0, endMs: 10_000 });
    expect(confirmBody({ speakerId: "A", resolution: personAt([a], "A", 5_000) })).toEqual({ action: "assign", speakerId: "A", personId: "p1", startMs: 0, endMs: 10_000 });
  });
});

describe("residual: turns named by a whole-voice proposal on a record voice", () => {
  const run = (speaker: string, from: number, to: number): Word[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => word(speaker, from + i * 1000, from + (i + 1) * 1000));
  // Voice A: record turn for p1 0-10 s; the rest (10-20 s, B 20-25 s, 25-35 s) is named p2 by a whole-voice transcript proposal.
  const words = [...run("A", 0, 20_000), ...run("B", 20_000, 25_000), ...run("A", 25_000, 35_000)];
  const names: NamesData = {
    persons,
    attributions: [
      att({ id: "1", speakerId: "A", personId: "p1", source: "record", status: "proposed", startMs: 0, endMs: 10_000 }),
      att({ id: "2", speakerId: "A", personId: "p2", source: "transcript", status: "proposed" }),
    ],
  };
  const q = whosWhoRows(names, words).find((r) => r.speakerId === "A" && r.resolution.kind === "named" && r.resolution.personId === "p2")!;
  const spans = [{ startMs: 10_000, endMs: 20_000 }, { startMs: 25_000, endMs: 35_000 }];
  it("Q's row has Q's spans as ranges and unconfirmed ranges", () => {
    expect(q.ranges).toEqual(spans);
    expect(q.unconfirmedRanges).toEqual(spans);
  });
  it("Confirm, Change… and No name send ranges", () => {
    expect(confirmBody(q)).toEqual({ action: "assign", speakerId: "A", personId: "p2", ranges: spans });
    expect(anonymousBody(q)).toEqual({ action: "anonymous", speakerId: "A", ranges: spans });
    expect(scopeFields(q.ranges, rowRange(q) ?? undefined)).toEqual({ ranges: spans });
  });
  it("a moment popover Confirm on a Q turn is a ranged assign, not a whole-voice confirm", () => {
    const res = personAt(names.attributions, "A", 12_000);
    expect(voiceConfirmBody(names, "A", res, { startMs: 10_000, endMs: 15_000 })).toEqual({ action: "assign", speakerId: "A", personId: "p2", startMs: 10_000, endMs: 15_000 });
    expect(voiceConfirmBody(names, "A", res)).toEqual({ action: "confirm", speakerId: "A" });
  });
  it("a moment holding another person's record turn confirms only the whole-voice part (never relabels the record turn)", () => {
    const res = personAt(names.attributions, "A", 12_000);
    // The moment spans p1's record turn (0-10 s) and p2's whole-voice part (10-15 s): only 10-15 s becomes p2.
    expect(voiceConfirmBody(names, "A", res, { startMs: 5_000, endMs: 15_000 })).toEqual({ action: "assign", speakerId: "A", personId: "p2", startMs: 10_000, endMs: 15_000 });
    // A moment inside the record turn leaves nothing for p2 to confirm.
    expect(voiceConfirmBody(names, "A", res, { startMs: 2_000, endMs: 8_000 })).toBeNull();
  });
  it("unconfirmedRangesIn for a conflict whose first attribution is whole-voice falls back to spans (no null)", () => {
    const n2: NamesData = {
      persons,
      attributions: [
        att({ id: "1", speakerId: "A", personId: "p1", source: "record", status: "proposed", startMs: 0, endMs: 5_000 }),
        att({ id: "2", speakerId: "A", personId: "p2", source: "caption", status: "proposed" }),
        att({ id: "3", speakerId: "A", personId: "p1", source: "transcript", status: "proposed" }),
      ],
    };
    const v = unconfirmedVoices(n2, run("A", 0, 20_000), { startMs: 6_000, endMs: 20_000 }, false);
    for (const x of v) expect(x.ranges.every((r) => r && typeof r.startMs === "number")).toBe(true);
  });
});

describe("reportTargetId", () => {
  const rows = [
    att({ id: "davi", speakerId: "E", personId: "p1", source: "record", startMs: 0, endMs: 60_000 }),
    att({ id: "damares", speakerId: "E", personId: "p2", source: "record", startMs: 60_000, endMs: 120_000 }),
  ];
  const names: NamesData = { persons, attributions: rows };
  it("points at the row of the instant the name was clicked, not the moment's start", () => {
    const moment = { startMs: 0, endMs: 120_000 };
    expect(reportTargetId(names, "E", { atMs: 70_000, range: moment })).toBe("damares");
    expect(reportTargetId(names, "E", { atMs: 10_000, range: moment })).toBe("davi");
  });
  it("falls back to the range, the first range, then 0; none for an unnamed voice", () => {
    expect(reportTargetId(names, "E", { range: { startMs: 60_000, endMs: 90_000 } })).toBe("damares");
    expect(reportTargetId(names, "E", { ranges: [{ startMs: 60_000, endMs: 90_000 }] })).toBe("damares");
    expect(reportTargetId(names, "E", {})).toBe("davi");
    expect(reportTargetId(names, "Z", { atMs: 0 })).toBeNull();
  });
});

describe("personDetail: the line under a name in Who's who", () => {
  const rec = (chamber: "senado" | "camara" | "bundestag" | "us_house" | undefined, url = "https://x", o: Partial<Attribution> = {}) =>
    att({ source: "record", status: "proposed", evidence: { kind: "record", speechId: "1", score: 0.9, url, fetchedAt: "2026-11-03", ...(chamber ? { chamber } : {}) }, ...o });
  const who = (o: Partial<Person>): Person => ({ ...person("p1", "X"), ...o });
  it("names the house of a person named from this session's record", () => {
    expect(personDetail(who({ party: "SPD" }), [rec("bundestag")])).toBe("SPD · Bundestag (Germany)");
    expect(personDetail(who({ party: "D", state: "NY" }), [rec("us_house")])).toBe("D-NY · House (USA)");
    expect(personDetail(who({ party: "PL", state: "ES" }), [rec("senado")])).toBe("PL-ES · Senado");
  });
  it("keeps whichever of party and state exists, and the role first", () => {
    expect(personDetail(who({ state: "SP" }), [rec("camara")])).toBe("SP · Câmara");
    expect(personDetail(who({ role: "Senador", party: "PL", state: "ES" }), [rec("senado")])).toBe("Senador · PL-ES · Senado");
    expect(personDetail(who({}), [rec("camara")])).toBe("Câmara");
  });
  it("infers the Brazilian house from the evidence url when the evidence has no chamber", () => {
    expect(personDetail(who({ party: "PL" }), [rec(undefined, "https://www.camara.leg.br/evento-legislativo/1")])).toBe("PL · Câmara");
    expect(personDetail(who({ party: "PL" }), [rec(undefined, "https://legis.senado.leg.br/dadosabertos/x")])).toBe("PL · Senado");
  });
  it("keeps today's line for a person not named from a record, or only by a superseded one", () => {
    expect(personDetail(who({ role: "Senador", party: "PL", state: "ES" }), [att({ source: "human" })])).toBe("Senador · PL · ES");
    expect(personDetail(who({ party: "SPD" }), [rec("bundestag", "https://x", { supersededAt: new Date(1) })])).toBe("SPD");
    expect(personDetail(who({ party: "SPD" }), [rec("bundestag", "https://x", { personId: "other" })])).toBe("SPD");
  });
});

describe("unconfirmedAcrossClips", () => {
  const names: NamesData = { persons, attributions: [att({ speakerId: "A", personId: "p1" })] };
  const words = [word("A", 0, 10_000), word("C", 10_000, 20_000), word("D", 20_000, 30_000), word("A", 30_000, 40_000), word("C", 40_000, 50_000)];
  const clip = (startMs: number, endMs: number, dismissed = false) => ({ startMs, endMs, words, dismissed });

  it("counts the voices that block any clip, and the clips they block", () => {
    const clips = [clip(10_000, 20_000), clip(20_000, 30_000), clip(0, 10_000), clip(40_000, 50_000)];
    expect(unconfirmedAcrossClips(clips, names, false)).toEqual({ voices: 2, clips: 3, blocking: { C: 2, D: 1 } });
  });
  it("counts a voice once however many clips it blocks", () => {
    expect(unconfirmedAcrossClips([clip(10_000, 20_000), clip(40_000, 50_000)], names, false)).toEqual({ voices: 1, clips: 2, blocking: { C: 2 } });
  });
  it("is zero when every voice is confirmed, and ignores clips whose approval was dismissed", () => {
    expect(unconfirmedAcrossClips([clip(0, 10_000)], names, false)).toEqual({ voices: 0, clips: 0, blocking: {} });
    expect(unconfirmedAcrossClips([clip(10_000, 20_000, true)], names, false)).toEqual({ voices: 0, clips: 0, blocking: {} });
    expect(unconfirmedAcrossClips([], names, false)).toEqual({ voices: 0, clips: 0, blocking: {} });
  });
});

describe("splitSpeakerQuestions", () => {
  const q = (id: string, target: "date" | "participant", speakerId: string | null) => ({ id, target, speakerId, question: "?", why: "w", sampleStartMs: null });
  it("moves a participant question into the Who's who row of its voice; the rest stay questions", () => {
    const out = splitSpeakerQuestions([q("participant:B", "participant", "B"), q("date", "date", null), q("participant:Z", "participant", "Z")], ["A", "B"]);
    expect(out.inline.map((x) => x.id)).toEqual(["participant:B"]);
    expect(out.rest.map((x) => x.id)).toEqual(["date", "participant:Z"]);
  });
});

describe("unconfirmedBannerText", () => {
  it("uses the spec copy with the right plural", () => {
    expect(unconfirmedBannerText({ voices: 2, clips: 4 })).toBe("2 voices aren't confirmed — they block 4 clips.");
    expect(unconfirmedBannerText({ voices: 1, clips: 1 })).toBe("1 voice isn't confirmed — it blocks 1 clip.");
    expect(unconfirmedBannerText({ voices: 1, clips: 3 })).toBe("1 voice isn't confirmed — it blocks 3 clips.");
    expect(unconfirmedBannerText({ voices: 2, clips: 1 })).toBe("2 voices aren't confirmed — they block 1 clip.");
  });
});

describe("visibleWhoRows", () => {
  const r = (speakerId: string, main: boolean) => ({ speakerId, main }) as WhosWhoRow;
  const rows = [r("A", true), r("B", true), r("C", false), r("D", false), r("E", false)];
  it("shows main voices only, plus the ones that block clips (first) and the ones asked about", () => {
    expect(visibleWhoRows(rows, { showAll: false, blocking: { D: 2 }, asked: new Set(["E"]) }).map((x) => x.speakerId)).toEqual(["D", "A", "B", "E"]);
  });
  it("without blockers keeps today's order, and show-all lists everything with blockers first", () => {
    expect(visibleWhoRows(rows, { showAll: false }).map((x) => x.speakerId)).toEqual(["A", "B"]);
    expect(visibleWhoRows(rows, { showAll: true, blocking: { D: 1 } }).map((x) => x.speakerId)).toEqual(["D", "A", "B", "C", "E"]);
  });
  it("shows every row when no voice is main", () => {
    expect(visibleWhoRows([r("C", false), r("D", false)], { showAll: false }).map((x) => x.speakerId)).toEqual(["C", "D"]);
  });
});

describe("readableRecordDate", () => {
  it("reads a day-first date with the month's name", () => {
    expect(readableRecordDate("04/11/2026", "bundestag")).toBe("4 Nov 2026");
    expect(readableRecordDate("21/10/2026", "senado")).toBe("21 Oct 2026");
    expect(readableRecordDate("30/06/2026")).toBe("30 Jun 2026");
  });
  it("reads the US houses month first", () => {
    expect(readableRecordDate("10/16/2026", "us_house")).toBe("16 Oct 2026");
    expect(readableRecordDate("11/04/2026", "us_senate")).toBe("4 Nov 2026");
  });
  it("keeps anything else as it is", () => {
    expect(readableRecordDate("2026-10-16", "bundestag")).toBe("2026-10-16");
    expect(readableRecordDate("31/13/2026", "camara")).toBe("31/13/2026");
  });
});
