import { describe, expect, it } from "vitest";
import type { Clip } from "@digestor/core";
import { clipLine, contextWindows } from "./askClips.js";

describe("askClips", () => {
  it("get_clip_context bounds: 60 s by default, at most 180, never past the video", () => {
    expect(contextWindows({ startMs: 120_000, endMs: 150_000 }, 600_000)).toEqual({ seconds: 60, before: { startMs: 60_000, endMs: 120_000 }, after: { startMs: 150_000, endMs: 210_000 } });
    expect(contextWindows({ startMs: 120_000, endMs: 150_000 }, 600_000, 500).seconds).toBe(180);
    expect(contextWindows({ startMs: 120_000, endMs: 150_000 }, 600_000, 0).seconds).toBe(1);
    expect(contextWindows({ startMs: 0, endMs: 30_000 }, 600_000).before).toBeNull();
    expect(contextWindows({ startMs: 570_000, endMs: 600_000 }, 600_000).after).toBeNull();
    expect(contextWindows({ startMs: 20_000, endMs: 40_000 }, 50_000, 60)).toMatchObject({ before: { startMs: 0, endMs: 20_000 }, after: { startMs: 40_000, endMs: 50_000 } });
  });

  const clip = { id: "c1", startMs: 3_723_000, endMs: 3_761_000, format: "9:16", renderStatus: "done", warningsAck: false } as Clip;
  const checks = { argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: "Missing the question", reportedSpeech: false, interpreter: false };

  it("clipLine says format, languages and their status, render, open checks and made with Ask", () => {
    const line = clipLine({
      n: 2, clip, title: "A title",
      moment: { startMs: clip.startMs, endMs: clip.endMs, checks },
      tracks: [{ language: "pt", status: "ready", approvedAt: null }, { language: "en", status: "ready", approvedAt: new Date() }],
      madeByAsk: true,
    });
    for (const part of ["Clip 2 · c1", "[01:02:03–01:02:41] 38 s", "9:16", "subtitles: pt draft, en approved", "render: done", "checks: 1 open (context)", "made with Ask", '"A title"']) {
      expect(line).toContain(part);
    }
  });

  it("clipLine: no subtitles, running checks, ok, cut away from the moment, acknowledged", () => {
    const base = { n: 1, clip, title: "T", tracks: [], madeByAsk: false };
    const l = (moment: Parameters<typeof clipLine>[0]["moment"], c = clip) => clipLine({ ...base, clip: c, moment });
    expect(l(null)).toContain("checks: running");
    expect(l(null)).toContain("subtitles: none");
    expect(l(null)).not.toContain("made with Ask");
    expect(l({ startMs: clip.startMs, endMs: clip.endMs, checks: { ...checks, contextRisk: null } })).toContain("checks: ok");
    expect(l({ startMs: 0, endMs: 1000, checks })).toContain("checks: made for the original cut");
    expect(l({ startMs: clip.startMs, endMs: clip.endMs, checks }, { ...clip, warningsAck: true })).toContain("checks: ok");
  });
});
