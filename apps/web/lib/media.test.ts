import { describe, expect, it, vi } from "vitest";
import { foundNoVideo, pauseAllMedia, sampleSrc } from "./media";

const ID = "6f1c1d1e-2b8a-4c55-9a3e-0c4a2f6b8d10";

describe("sampleSrc", () => {
  it("plays the preview copy when it is ready, the audio until then", () => {
    expect(sampleSrc(ID, true)).toBe(`/api/files/${ID}/proxy.mp4`);
    expect(sampleSrc(ID, false)).toBe(`/api/files/${ID}/audio.mp3`);
  });
});

describe("foundNoVideo", () => {
  it("is true only when the worker found no picture and the upload wasn't acknowledged as audio", () => {
    expect(foundNoVideo({ hasVideo: false, audioOnlyAck: false })).toBe(true);
    expect(foundNoVideo({ hasVideo: false, audioOnlyAck: true })).toBe(false); // the journalist saw the notice at upload
    expect(foundNoVideo({ hasVideo: true, audioOnlyAck: false })).toBe(false);
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
