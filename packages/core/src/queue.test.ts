import { describe, expect, it } from "vitest";
import {
  AskJobSchema, BurnTrackJobSchema, CheckMomentJobSchema, JOB_OPTIONS, PrepareTrackJobSchema, QUEUES, ReanalyzeJobSchema,
  RenderClipJobSchema, TranslateBriefingJobSchema,
} from "./queue.ts";

const ID = "6f1c1d1e-2b8a-4c55-9a3e-0c4a2f6b8d10";

describe("JOB_OPTIONS", () => {
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
    });
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
