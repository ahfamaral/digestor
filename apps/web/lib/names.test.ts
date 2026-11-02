import { describe, expect, it } from "vitest";
import type { Attribution, Person, Word } from "@digestor/core";
import { unconfirmedVoices, badgeText, evidenceLine, momentPeople, rangeVoices, voiceLabel, whosWhoRows, rowRange, confirmBody, anonymousBody, conflictText, type NamesData } from "./names";

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
    expect(second).toMatchObject({ range: null, confirm: null }); // the unnamed rest of the voice
    const whole: NamesData = { persons, attributions: [att({ speakerId: "C", personId: "p1", source: "caption", status: "proposed" })] };
    expect(unconfirmedVoices(whole, words, { startMs: 0, endMs: 20_000 }, false)).toMatchObject([{ range: null, confirm: { action: "confirm", speakerId: "C" } }]);
  });
});
