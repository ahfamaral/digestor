import { describe, expect, it, vi } from "vitest";
import { pauseAllMedia, sampleSrc } from "./media";

const ID = "6f1c1d1e-2b8a-4c55-9a3e-0c4a2f6b8d10";

describe("sampleSrc", () => {
  it("plays the preview copy when it is ready, the audio until then", () => {
    expect(sampleSrc(ID, true)).toBe(`/api/files/${ID}/proxy.mp4`);
    expect(sampleSrc(ID, false)).toBe(`/api/files/${ID}/audio.mp3`);
  });
});

describe("pauseAllMedia", () => {
  it("pauses only playing elements and counts them", () => {
    const a = { paused: false, pause: vi.fn() },
      b = { paused: true, pause: vi.fn() };
    expect(pauseAllMedia({ querySelectorAll: () => [a, b] as never })).toBe(1);
    expect(a.pause).toHaveBeenCalledOnce();
    expect(b.pause).not.toHaveBeenCalled();
  });
});
