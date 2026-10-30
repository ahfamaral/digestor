import { describe, expect, it } from "vitest";
import type { MomentChecks } from "./analysisTypes.ts";
import { exportChecklist } from "./checklist.ts";

const clean: MomentChecks = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};
const clip = { credit: "Parliament TV", noCreditNeeded: false, warningsAck: false, protectedAck: false };
const run = (over: Partial<Parameters<typeof exportChecklist>[0]> = {}) =>
  Object.fromEntries(exportChecklist({ clip, checks: clean, tracks: [], profile: "interview", ...over }).map((i) => [i.id, i.ok]));

describe("exportChecklist", () => {
  it("passes a clean clip", () => {
    expect(run()).toEqual({ argument: true, context: true, flags: true, subtitles: true, credit: true });
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
});
