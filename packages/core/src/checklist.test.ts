import { describe, expect, it } from "vitest";
import type { MomentChecks } from "./analysisTypes.ts";
import { speakersInRange, type Attribution } from "./attribution.ts";
import type { Word } from "./schemas.ts";
import { checksForClip, exportChecklist } from "./checklist.ts";

const clean: MomentChecks = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};
const clip = { credit: "Parliament TV", noCreditNeeded: false, warningsAck: false, protectedAck: false, startMs: 10_000, endMs: 40_000 };
const moment = (checks: MomentChecks | null) => ({ startMs: 10_000, endMs: 40_000, checks });
type Over = Partial<Omit<Parameters<typeof exportChecklist>[0], "moment">> & { checks?: MomentChecks | null };
const run = ({ checks = clean, ...over }: Over = {}) =>
  Object.fromEntries(
    exportChecklist({ clip, moment: moment(checks), tracks: [], profile: "interview", speakers: [], ...over }).map((i) => [i.id, i.ok]),
  );

describe("exportChecklist", () => {
  it("passes a clean clip", () => {
    expect(run()).toEqual({ argument: true, context: true, flags: true, subtitles: true, credit: true, speaker: true });
  });
  it("argument: needs a complete argument or an acknowledgement", () => {
    expect(run({ checks: { ...clean, argumentComplete: false } }).argument).toBe(false);
    expect(run({ checks: { ...clean, argumentComplete: false }, clip: { ...clip, warningsAck: true } }).argument).toBe(true);
  });
  it("context: a context risk blocks until acknowledged", () => {
    expect(run({ checks: { ...clean, contextRisk: "Answers a different question" } }).context).toBe(false);
    expect(run({ checks: { ...clean, contextRisk: "x" }, clip: { ...clip, warningsAck: true } }).context).toBe(true);
  });
  it("flags: reported speech or an interpreter block until acknowledged", () => {
    expect(run({ checks: { ...clean, reportedSpeech: true } }).flags).toBe(false);
    expect(run({ checks: { ...clean, interpreter: true } }).flags).toBe(false);
    expect(run({ checks: { ...clean, interpreter: true }, clip: { ...clip, warningsAck: true } }).flags).toBe(true);
  });
  it("null checks pass only with an acknowledgement", () => {
    expect(run({ checks: null })).toMatchObject({ argument: false, context: false, flags: false });
    expect(run({ checks: null, clip: { ...clip, warningsAck: true } })).toMatchObject({ argument: true, context: true, flags: true });
  });
  it("subtitles: every track with a burn request must be approved", () => {
    const t = (burnStatus: "none" | "stale" | "done", approved: boolean) => ({
      burnStatus, approvedAt: approved ? new Date() : null, status: "ready" as const,
    });
    expect(run({ tracks: [t("none", false)] }).subtitles).toBe(true);
    expect(run({ tracks: [t("stale", false)] }).subtitles).toBe(false);
    expect(run({ tracks: [t("stale", true), t("none", false)] }).subtitles).toBe(true);
  });
  it("subtitles: an approved track that isn't ready still fails", () => {
    const track = { burnStatus: "stale" as const, approvedAt: new Date(), status: "failed" as const };
    expect(run({ tracks: [track] }).subtitles).toBe(false);
  });
  it("subtitles: an outdated track fails even without a burn request", () => {
    const t = (status: "ready" | "outdated") => ({ burnStatus: "none" as const, approvedAt: null, status });
    expect(run({ tracks: [t("ready")] }).subtitles).toBe(true);
    expect(run({ tracks: [t("ready"), t("outdated")] }).subtitles).toBe(false);
  });
  it("checks apply only while the clip has its moment's bounds (R28)", () => {
    const trimmed = { ...clip, endMs: 38_000 };
    expect(run({ clip: trimmed })).toMatchObject({ argument: false, context: false, flags: false });
    expect(run({ clip: { ...trimmed, warningsAck: true } })).toMatchObject({ argument: true, context: true, flags: true });
    expect(exportChecklist({ clip: trimmed, moment: null, tracks: [], profile: "interview", speakers: [] }).find((i) => i.id === "argument")?.ok).toBe(false);
  });
  it("checksForClip says whether the checks belong to this cut", () => {
    expect(checksForClip(clip, moment(clean))).toEqual({ checks: clean, originalCut: false });
    expect(checksForClip(clip, moment(null))).toEqual({ checks: null, originalCut: false });
    expect(checksForClip({ ...clip, startMs: 9_000 }, moment(clean))).toEqual({ checks: null, originalCut: true });
    expect(checksForClip(clip, null)).toEqual({ checks: null, originalCut: false });
  });
  it("credit: text or the no-credit box", () => {
    expect(run({ clip: { ...clip, credit: null } }).credit).toBe(false);
    expect(run({ clip: { ...clip, credit: "  " } }).credit).toBe(false);
    expect(run({ clip: { ...clip, credit: null, noCreditNeeded: true } }).credit).toBe(true);
  });
  it("protected applies to trial only", () => {
    expect("protected" in run({ profile: "interview" })).toBe(false);
    expect(run({ profile: "trial" }).protected).toBe(false);
    expect(run({ profile: "trial", clip: { ...clip, protectedAck: true } }).protected).toBe(true);
  });

  describe("speaker", () => {
    const att = (o: Partial<Attribution>): Attribution => ({
      id: Math.random().toString(), sessionId: "S", speakerId: "C", startMs: null, endMs: null, personId: "P1", source: "transcript",
      status: "proposed", confidence: 0.5, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(2026, 10, 2), supersededAt: null, ...o,
    });
    const voice = (speakerId: string, startMs: number, endMs: number): Word => ({ text: "x", startMs, endMs, speaker: speakerId, confidence: 1 });
    const speakerOk = (atts: Attribution[], words: Word[], over: Partial<typeof clip> = {}) => {
      const c = { ...clip, ...over };
      return run({ clip: c, speakers: speakersInRange(words, atts, c) }).speaker;
    };
    const words = [voice("A", 10_000, 25_000), voice("C", 25_000, 40_000)];

    it("passes only for confirmed or anonymous voices", () => {
      expect(speakerOk([att({ status: "proposed" })], words)).toBe(false);
      expect(speakerOk([att({ status: "proposed" })], words, { warningsAck: true })).toBe(false);
      expect(speakerOk([att({ status: "proposed", personId: "P1" }), att({ source: "human", status: "confirmed", personId: "P2" }), att({ source: "human", status: "confirmed", personId: "P3", speakerId: "A" })], words)).toBe(true);
      expect(speakerOk([att({ source: "human", status: "anonymous", personId: null }), att({ source: "human", status: "anonymous", personId: null, speakerId: "A" })], words)).toBe(true);
      expect(speakerOk([], words)).toBe(false); // unnamed
      const two = [
        att({ source: "caption", status: "proposed", personId: "P1" }), att({ source: "transcript", status: "proposed", personId: "P2" }),
        att({ source: "human", status: "confirmed", personId: "P3", speakerId: "A" }),
      ];
      expect(speakerOk(two, words)).toBe(false); // conflict
    });
    it("the speaker item counts a voice by its total time", () => {
      // C: 0-2 s proposed as P1 (whole voice), 2-4 s unnamed (a ranged human "no name" elsewhere keeps the rest apart)
      const part = [att({ startMs: 0, endMs: 2_000 })];
      const both = [voice("C", 0, 2_000), voice("C", 2_000, 4_000)];
      expect(speakerOk(part, both, { startMs: 0, endMs: 4_000 })).toBe(false); // 4 s total, each part under 3 s
      expect(speakerOk(part, [voice("C", 0, 2_000)], { startMs: 0, endMs: 4_000 })).toBe(true); // 2 s total: ignored
    });
    it("follows the clip's bounds", () => {
      const atts = [att({ source: "human", status: "confirmed", personId: "P3", speakerId: "A" })];
      const w = [voice("A", 0, 10_000), voice("C", 14_000, 20_000)];
      expect(speakerOk(atts, w, { startMs: 0, endMs: 10_000 })).toBe(true);
      expect(speakerOk(atts, w, { startMs: 0, endMs: 20_000 })).toBe(false);
      expect(speakerOk(atts, w, { startMs: 0, endMs: 10_000 })).toBe(true);
    });
  });
});
