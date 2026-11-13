import { describe, expect, it } from "vitest";
import {
  AskJobSchema, AskResumeJobSchema, BurnTrackJobSchema, CheckMomentJobSchema, JOB_OPTIONS, LibraryAskJobSchema, PrepareTrackJobSchema, ProxyJobSchema, QUEUES, ReanalyzeJobSchema,
  RenderClipJobSchema, ResumeJobSchema, TranslateBriefingJobSchema,
} from "./queue.ts";

const ID = "6f1c1d1e-2b8a-4c55-9a3e-0c4a2f6b8d10";

describe("ResumeJobSchema", () => {
  const base = { sessionId: ID, payload: { action: "skip" } };
  it("accepts a round and accepts a job without one; rejects round 0", () => {
    expect(ResumeJobSchema.parse({ ...base, round: 2 }).round).toBe(2);
    expect(ResumeJobSchema.parse(base).round).toBeUndefined();
    expect(ResumeJobSchema.safeParse({ ...base, round: 0 }).success).toBe(false);
    expect(ResumeJobSchema.safeParse({ ...base, round: 1.5 }).success).toBe(false);
  });
});

describe("JOB_OPTIONS", () => {
  it("ReanalyzeJobSchema takes an optional analysisId", () => {
    const base = { sessionId: ID, profile: "parliament", reason: "r" };
    expect(ReanalyzeJobSchema.parse({ ...base, analysisId: ID }).analysisId).toBe(ID);
    expect(ReanalyzeJobSchema.parse(base).analysisId).toBeUndefined();
    expect(ReanalyzeJobSchema.safeParse({ ...base, analysisId: "x" }).success).toBe(false);
  });

  it("is the single source of queue and send options: retries, 12 h expiry and a 60 s heartbeat", () => {
    expect(JOB_OPTIONS).toEqual({ retryLimit: 2, retryDelay: 30, expireInSeconds: 43200, heartbeatSeconds: 60 });
  });
});

describe("QUEUES", () => {
  it("names every queue exactly", () => {
    expect(QUEUES).toEqual({
      start: "session.start",
      resume: "session.resume",
      reanalyze: "session.reanalyze",
      checkMoment: "moment.check",
      prepareTrack: "track.prepare",
      burnTrack: "track.burn",
      renderClip: "clip.render",
      translateBriefing: "briefing.translate",
      ask: "ask.run",
      askResume: "ask.resume",
      askLibrary: "ask.library",
      findMore: "moment.find_more",
      names: "session.names",
      proxy: "session.proxy",
    });
  });

  it("the Ask resume job takes the decided action's id", () => {
    expect(AskResumeJobSchema.parse({ actionId: ID })).toEqual({ actionId: ID });
    expect(AskResumeJobSchema.safeParse({ actionId: "x" }).success).toBe(false);
  });

  it("the Ask-across-videos job takes the pending answer's id", () => {
    expect(LibraryAskJobSchema.parse({ messageId: ID })).toEqual({ messageId: ID });
    expect(LibraryAskJobSchema.safeParse({ messageId: "x" }).success).toBe(false);
  });

  it("the preview copy job takes a session id", () => {
    expect(ProxyJobSchema.parse({ sessionId: ID })).toEqual({ sessionId: ID });
    expect(ProxyJobSchema.safeParse({ sessionId: "x" }).success).toBe(false);
  });

  it("validates each new payload", () => {
    expect(ReanalyzeJobSchema.parse({ sessionId: ID, profile: "parliament", reason: "wrong profile" })).toEqual({
      sessionId: ID, profile: "parliament", reason: "wrong profile",
    });
    expect(ReanalyzeJobSchema.safeParse({ sessionId: ID, profile: "debate", reason: "x" }).success).toBe(false);
    expect(ReanalyzeJobSchema.safeParse({ sessionId: ID, profile: "trial", reason: " " }).success).toBe(false);
    expect(CheckMomentJobSchema.parse({ momentId: ID })).toEqual({ momentId: ID });
    expect(CheckMomentJobSchema.safeParse({ momentId: "nope" }).success).toBe(false);
    expect(PrepareTrackJobSchema.parse({ trackId: ID })).toEqual({ trackId: ID });
    expect(BurnTrackJobSchema.parse({ trackId: ID })).toEqual({ trackId: ID });
    expect(RenderClipJobSchema.parse({ clipId: ID })).toEqual({ clipId: ID });
    expect(TranslateBriefingJobSchema.parse({ analysisId: ID, language: "pt" })).toEqual({ analysisId: ID, language: "pt" });
    expect(TranslateBriefingJobSchema.safeParse({ analysisId: ID, language: "xx" }).success).toBe(false);
    expect(AskJobSchema.parse({ messageId: ID })).toEqual({ messageId: ID });
    expect(AskJobSchema.safeParse({}).success).toBe(false);
  });
});
