import { describe, expect, it } from "vitest";
import { sampleSrc } from "./media";

const ID = "6f1c1d1e-2b8a-4c55-9a3e-0c4a2f6b8d10";

describe("sampleSrc", () => {
  it("plays the preview copy when it is ready, the audio until then", () => {
    expect(sampleSrc(ID, true)).toBe(`/api/files/${ID}/proxy.mp4`);
    expect(sampleSrc(ID, false)).toBe(`/api/files/${ID}/audio.mp3`);
  });
});
