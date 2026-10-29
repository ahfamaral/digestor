import { describe, expect, it } from "vitest";
import { buildSteps } from "./processingSteps";

const states = (s: ReturnType<typeof buildSteps>) => s.map((x) => `${x.label}:${x.state}`);

describe("buildSteps", () => {
  it("marks earlier steps done, the current running, later waiting", () => {
    expect(states(buildSteps("transcribing", "upload"))).toEqual([
      "Preparing video:done", "Transcribing:running", "Understanding context:waiting", "Finding moments:waiting",
    ]);
  });
  it("adds the download step first for YouTube; uploaded is before step 1", () => {
    expect(buildSteps("uploaded", "youtube")[0]).toMatchObject({ label: "Downloading from YouTube", state: "waiting" });
    expect(buildSteps("downloading", "youtube")[0].state).toBe("running");
  });
  it("shows a single rendering step", () => {
    expect(states(buildSteps("rendering", "upload"))).toEqual(["Rendering clips:running"]);
  });
});
