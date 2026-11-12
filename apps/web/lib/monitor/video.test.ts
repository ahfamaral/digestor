import { describe, expect, it } from "vitest";
import { embedUrl, videoLength, videoPosition, watchUrl } from "./video";

describe("monitor video helpers", () => {
  const v = { videoId: "NmI46Y25mEU", startS: 76, endS: 414 };

  it("formats positions as h:mm:ss and lengths as m:ss", () => {
    expect(videoPosition(76)).toBe("0:01:16");
    expect(videoPosition(4707.9)).toBe("1:18:27");
    expect(videoLength(338)).toBe("5:38");
    expect(videoLength(3725)).toBe("62:05");
    expect(videoLength(-3)).toBe("0:00");
  });

  it("builds the privacy-enhanced embed and the YouTube link at the start", () => {
    expect(embedUrl(v)).toBe("https://www.youtube-nocookie.com/embed/NmI46Y25mEU?start=76&end=414&autoplay=1&rel=0");
    expect(watchUrl(v)).toBe("https://www.youtube.com/watch?v=NmI46Y25mEU&t=76s");
  });

  it("refuses anything that isn't a YouTube id", () => {
    expect(embedUrl({ ...v, videoId: "x\"><script>" })).toBeNull();
    expect(watchUrl({ ...v, videoId: "../../evil" })).toBeNull();
  });
});
