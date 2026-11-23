import { describe, expect, it } from "vitest";
import type { TrackCue } from "@digestor/core";
import { clipPosition, cueAt, editorCues, previewCss, reviewColumns, seekFor, spokenTokens, startingLook, subtitlePositions, upcomingColor } from "./subtitlePreview";

describe("subtitle positions", () => {
  it("offer Above name banner only when there is a picture", () => {
    expect(subtitlePositions(true)).toEqual(["bottom", "above_banner", "top"]);
    expect(subtitlePositions(false)).toEqual(["bottom", "top"]);
  });
  it("an audio clip stored above the banner starts at the bottom in the dialog; others keep their look", () => {
    expect(startingLook({ style: "white", position: "above_banner" }, false)).toEqual({ style: "white", position: "bottom" });
    expect(startingLook({ style: "white", position: "above_banner" }, true)).toEqual({ style: "white", position: "above_banner" });
    expect(startingLook({ style: "yellow", position: "top" }, false)).toEqual({ style: "yellow", position: "top" });
  });
});

describe("previewCss", () => {
  it("draws yellow above the banner like the render", () => {
    const css = previewCss({ style: "yellow", position: "above_banner", format: "16:9" }, 540);
    expect(css).toMatchObject({ color: "#FFE600", fontWeight: 700, bottom: "22%" });
    expect(css.fontSize).toBeCloseTo(29.7, 5);
    expect(css.top).toBeUndefined();
  });
  it("scales the 4 px / 1 px border from 1080p", () => {
    const css = previewCss({ style: "white", position: "bottom", format: "16:9" }, 540);
    // outline 2 px outside at 540p = a 4 px centred stroke, fill painted over it
    expect(css.WebkitTextStroke).toBe("4px #000");
    expect(css.paintOrder).toBe("stroke fill");
    expect(css.textShadow).toBe("0px 1px 0px #000");
  });
  it("white_box has a 75% dark box and regular weight", () => {
    const css = previewCss({ style: "white_box", position: "bottom", format: "16:9" }, 1080);
    expect(css.backgroundColor).toBe("rgba(0,0,0,0.75)");
    expect(css.fontWeight).toBe(400);
    expect(css.bottom).toBe("6%");
  });
  it("top sets top and no bottom", () => {
    const css = previewCss({ style: "yellow", position: "top", format: "16:9" }, 540);
    expect(css.top).toBe("5%");
    expect(css.bottom).toBeUndefined();
  });
  it("9:16 uses a 4% font, 16:9 5.5%", () => {
    expect(previewCss({ style: "white", position: "bottom", format: "9:16" }, 400).fontSize).toBeCloseTo(16, 5);
    expect(previewCss({ style: "white", position: "bottom", format: "16:9" }, 400).fontSize).toBeCloseTo(22, 5);
  });
});

describe("review with playback", () => {
  const cues = [
    { startMs: 100, endMs: 2000 },
    { startMs: 2000, endMs: 3500 },
    { startMs: 4000, endMs: 5000 },
  ];
  it("cueAt: the cue playing at a clip-relative time, -1 in a gap or outside", () => {
    expect(cueAt(cues, 0)).toBe(-1);
    expect(cueAt(cues, 100)).toBe(0);
    expect(cueAt(cues, 1999)).toBe(0);
    expect(cueAt(cues, 2000)).toBe(1);
    expect(cueAt(cues, 3700)).toBe(-1);
    expect(cueAt(cues, 4999)).toBe(2);
    expect(cueAt(cues, 5000)).toBe(-1);
  });
  it("seekFor: cues are clip-relative, the proxy is session-absolute (seconds)", () => {
    expect(seekFor(cues[1]!, { startMs: 60_000 })).toBe(62);
    expect(seekFor(cues[0]!, { startMs: 0 })).toBe(0.1);
  });
  it("clipPosition: the player counts from the clip start, like the cues, and stays inside the clip", () => {
    const clip = { startMs: 750_000, endMs: 795_000 }; // a clip at 12:30 that runs 45 s
    expect(clipPosition(750, clip)).toBe(0);
    expect(clipPosition(762.3, clip)).toBe(12_300);
    expect(clipPosition(795, clip)).toBe(45_000);
    expect(clipPosition(800, clip)).toBe(45_000);
    expect(clipPosition(10, clip)).toBe(0);
  });
  it("one column when the track is the video's own language", () => {
    expect(reviewColumns("de", "de")).toBe(1);
    expect(reviewColumns("pt", "pt-BR")).toBe(1);
    expect(reviewColumns("en", "de")).toBe(2);
    expect(reviewColumns("en", undefined)).toBe(2);
    expect(reviewColumns("en", null)).toBe(2);
  });
});

describe("editor preview helpers", () => {
  const words = [{ startMs: 0, endMs: 300, chars: 2 }, { startMs: 400, endMs: 700, chars: 4 }];
  const line: TrackCue = { startMs: 0, endMs: 700, original: "um dois", text: "um dois", missing: false, words };

  it("editorCues uses the unsaved texts", () => {
    expect(editorCues([line], ["one two"], "16:9", false)[0]!.lines).toEqual(["one two"]);
    expect(editorCues([line], [], "16:9", false)[0]!.lines).toEqual(["um dois"]);
  });

  it("editorCues highlights only lines that are still the spoken words", () => {
    expect(editorCues([line], ["um dois"], "16:9", true)[0]!.karaoke).toEqual([0, 400]);
    expect(editorCues([line], ["one two"], "16:9", true)[0]!.karaoke).toBeUndefined();
  });

  it("spokenTokens counts the words that have started", () => {
    const cue = { startMs: 0, endMs: 700, lines: ["um dois"], karaoke: [0, 400] };
    expect(spokenTokens(cue, 0)).toBe(1);
    expect(spokenTokens(cue, 399)).toBe(1);
    expect(spokenTokens(cue, 400)).toBe(2);
    expect(spokenTokens({ startMs: 0, endMs: 1, lines: ["x"] }, 5)).toBe(0);
  });

  it("upcomingColor dims the style's colour like the burn", () => {
    expect(upcomingColor("yellow_box")).toBe("#FFE6008c");
  });
});
