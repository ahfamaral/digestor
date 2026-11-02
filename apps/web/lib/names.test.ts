import { describe, expect, it } from "vitest";
import type { Attribution, Person, Word } from "@digestor/core";
import { badgeText, evidenceLine, momentPeople, voiceLabel, type NamesData } from "./names";

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
