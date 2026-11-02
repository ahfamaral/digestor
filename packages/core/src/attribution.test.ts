import { describe, expect, it } from "vitest";
import type { Word } from "./schemas.ts";
import {
  FOCUS_MIN_MS,
  closeMatches,
  normaliseName,
  peopleInRange,
  personAt,
  speakerLabel,
  turnsOf,
  type Attribution,
  type Person,
  type Resolution,
} from "./attribution.ts";

let n = 0;
const att = (o: Partial<Attribution>): Attribution => ({
  id: `att${++n}`,
  sessionId: "S",
  speakerId: "B",
  startMs: null,
  endMs: null,
  personId: "P1",
  source: "transcript",
  status: "proposed",
  confidence: 0.5,
  evidence: { kind: "none" },
  createdBy: "owner",
  createdAt: new Date(2026, 10, 2),
  supersededAt: null,
  ...o,
});
const w = (speaker: string, startMs: number, endMs = startMs + 500, text = "x"): Word => ({ text, startMs, endMs, speaker, confidence: 1 });
const person = (displayName: string, id = displayName): Person => ({
  id,
  displayName,
  fullName: null,
  kind: "custom",
  party: null,
  state: null,
  role: null,
  photoUrl: null,
  officialIds: {},
});

describe("personAt", () => {
  it("prefers human, then confirmed record, then a single proposed person", () => {
    const proposed = att({ personId: "P1" });
    expect(personAt([proposed], "B", 15_000)).toMatchObject({ kind: "named", personId: "P1", confirmed: false });

    const record = att({ personId: "P2", source: "record", status: "confirmed", startMs: 10_000, endMs: 20_000, confidence: 0.9 });
    expect(personAt([proposed, record], "B", 15_000)).toMatchObject({ kind: "named", personId: "P2", confirmed: true });
    expect(personAt([proposed, record], "B", 5_000)).toMatchObject({ kind: "named", personId: "P1", confirmed: false });

    const human = att({ personId: "P3", source: "human", status: "confirmed" });
    for (const ms of [5_000, 15_000, 25_000]) {
      expect(personAt([proposed, record, human], "B", ms)).toMatchObject({ kind: "named", personId: "P3", confirmed: true });
    }

    const anon = att({ personId: null, source: "human", status: "anonymous", startMs: 30_000, endMs: 40_000 });
    expect(personAt([proposed, record, human, anon], "B", 35_000).kind).toBe("anonymous");
    expect(personAt([proposed, record, human, anon], "B", 40_000)).toMatchObject({ kind: "named", personId: "P3" });
  });

  it("treats superseded and rejected rows as absent", () => {
    const sup = att({ supersededAt: new Date() });
    const rej = att({ status: "rejected" });
    expect(personAt([sup, rej], "B", 1000)).toEqual({ kind: "unnamed" });
    expect(personAt([att({})], "A", 1000)).toEqual({ kind: "unnamed" });
  });

  it("returns conflict when two proposed sources name different persons", () => {
    const a = att({ personId: "P1", source: "caption" });
    const b = att({ personId: "P2", source: "transcript" });
    const r = personAt([a, b], "B", 0);
    expect(r.kind).toBe("conflict");
    if (r.kind === "conflict") expect(r.attributions).toEqual([a, b]);
  });

  it("picks the proposed attribution by source order", () => {
    const t = att({ personId: "P1", source: "transcript" });
    const c = att({ personId: "P1", source: "caption" });
    const r = personAt([t, c], "B", 0);
    expect(r).toMatchObject({ kind: "named", personId: "P1", confirmed: false });
    if (r.kind === "named") expect(r.attribution).toBe(c);
  });
});

describe("peopleInRange", () => {
  it("ignores voices under FOCUS_MIN_MS", () => {
    expect(FOCUS_MIN_MS).toBe(3000);
    const words = [w("A", 0, 10_000), w("B", 5000, 5500)];
    const out = peopleInRange(words, [], { startMs: 0, endMs: 10_000 });
    expect(out.map((o) => o.speakerId)).toEqual(["A"]);
    expect(out[0]!.ms).toBeCloseTo(10_000, -2);
    expect(out[0]!.resolution).toEqual({ kind: "unnamed" });

    const more = [w("A", 0, 6000), w("B", 6000, 10_000)];
    const both = peopleInRange(more, [], { startMs: 0, endMs: 10_000 });
    expect(both.map((o) => o.speakerId)).toEqual(["A", "B"]);
  });

  it("keeps one entry per voice even when two voices resolve to the same person", () => {
    const words = [w("A", 0, 4000), w("B", 4000, 8000)];
    const atts = [att({ speakerId: "A", personId: "P1" }), att({ speakerId: "B", personId: "P1" })];
    const out = peopleInRange(words, atts, { startMs: 0, endMs: 8000 });
    expect(out).toHaveLength(2);
  });
});

describe("turnsOf", () => {
  it("splits on speaker change and keeps text", () => {
    const words = [w("A", 0, 400, "Hello"), w("A", 500, 900, "there"), w("B", 1000, 1400, "Hi"), w("A", 1500, 1900, "Bye")];
    expect(turnsOf(words)).toEqual([
      { speakerId: "A", startMs: 0, endMs: 900, text: "Hello there" },
      { speakerId: "B", startMs: 1000, endMs: 1400, text: "Hi" },
      { speakerId: "A", startMs: 1500, endMs: 1900, text: "Bye" },
    ]);
    expect(turnsOf([])).toEqual([]);
  });
});

describe("normaliseName and closeMatches", () => {
  it("normalises", () => {
    expect(normaliseName("  Flávio  BOLSONARO.")).toBe("flavio bolsonaro");
  });
  it("matches whole tokens only", () => {
    const lula = person("Luiz Inácio Lula da Silva");
    const lulu = person("Lulu Santos");
    expect(closeMatches("Lula", [lula, lulu])).toEqual([lula]);
    expect(closeMatches("Luiz Inácio Lula da Silva Junior", [lula, lulu])).toEqual([lula]);
    expect(closeMatches("", [lula])).toEqual([]);
  });
});

describe("speakerLabel", () => {
  const persons = new Map([["P1", person("Ana Souza", "P1")]]);
  const fallback = { text: "Speaker C", badge: null, proposed: false };
  it("shows the fallback for unnamed, anonymous and conflict", () => {
    const a = att({});
    const rs: Resolution[] = [{ kind: "unnamed" }, { kind: "anonymous", attribution: a }, { kind: "conflict", attributions: [a] }];
    for (const r of rs) expect(speakerLabel(r, persons, "C", false)).toEqual(fallback);
  });
  it("names people, flags proposed, and hides unconfirmed names when sensitive", () => {
    const a = att({ source: "caption" });
    const proposed: Resolution = { kind: "named", personId: "P1", confirmed: false, attribution: a };
    expect(speakerLabel(proposed, persons, "C", false)).toEqual({ text: "Ana Souza", badge: "caption", proposed: true });
    expect(speakerLabel(proposed, persons, "C", true)).toEqual(fallback);
    const confirmed: Resolution = { kind: "named", personId: "P1", confirmed: true, attribution: a };
    expect(speakerLabel(confirmed, persons, "C", true)).toEqual({ text: "Ana Souza", badge: "caption", proposed: false });
    expect(speakerLabel({ ...confirmed, personId: "missing" }, persons, "C", false)).toEqual(fallback);
  });
});
