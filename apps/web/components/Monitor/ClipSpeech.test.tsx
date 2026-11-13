import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clipMinutes, clipSection, monitorClipEnabled, speakerLabel } from "@/lib/monitor/clip";
import { SpeechItem } from "./SpeechItem";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => vi.unstubAllEnvs());

const row = {
  id: 5, startsAt: "2026-06-30T14:24", phase: "Breves Comunicações", kind: null, summary: "", text: "O SR. X (PL - RS.) - Quero falar hoje.",
  urlText: null, textFile: false, video: { videoId: "NmI46Y25mEU", startS: 76, endS: 414 }, speechKey: "1:2026-06-30T14:24:abc",
};
const DISABLED = "Clipping downloads the video from YouTube, which this server can&#x27;t do. Open the monitor on your own computer to clip this speech.";

describe("Clip this speech", () => {
  it("on: the button sits next to the video controls", () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const html = renderToStaticMarkup(<ul><SpeechItem locale="en" speech={row} /></ul>);
    expect(html).toContain("Clip this speech");
    expect(html).not.toContain(DISABLED);
    expect(renderToStaticMarkup(<ul><SpeechItem locale="pt-BR" speech={row} /></ul>)).toContain("Recortar este discurso");
  });

  it("off (missing or not exactly \"true\"): the line says why, no button", () => {
    for (const v of ["", "1", "TRUE"]) {
      vi.stubEnv("MONITOR_CLIP_ENABLED", v);
      const html = renderToStaticMarkup(<ul><SpeechItem locale="en" speech={row} /></ul>);
      expect(html).toContain(DISABLED);
      expect(html).not.toContain("Clip this speech");
    }
  });

  it("nothing about clipping for a speech without a video moment or a key", () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    expect(renderToStaticMarkup(<ul><SpeechItem locale="en" speech={{ ...row, video: null }} /></ul>)).not.toContain("Clip this speech");
    expect(renderToStaticMarkup(<ul><SpeechItem locale="en" speech={{ ...row, speechKey: null }} /></ul>)).not.toContain("Clip this speech");
  });

  it("section: 20 s either side, clamped at 0 and at the video's end; minutes for the dialog", () => {
    expect(clipSection({ startS: 76, endS: 414 })).toEqual({ startS: 56, endS: 434 });
    expect(clipSection({ startS: 5, endS: 50 }, 60)).toEqual({ startS: 0, endS: 60 });
    expect(clipSection({ startS: 5, endS: 50 }, null)).toEqual({ startS: 0, endS: 70 });
    expect(clipMinutes({ startS: 76, endS: 414 })).toBe(6);
    expect(clipMinutes({ startS: 100, endS: 110 })).toBe(1);
    expect(monitorClipEnabled({})).toBe(false);
    expect(monitorClipEnabled({ MONITOR_CLIP_ENABLED: "true" })).toBe(true);
    expect(speakerLabel("Ana", null, null)).toBe("Ana");
    expect(speakerLabel("Ana", "PT", "SP")).toBe("Ana (PT-SP)");
  });
});
