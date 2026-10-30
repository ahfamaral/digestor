import { describe, expect, it } from "vitest";
import { buildSteps } from "./processingSteps";

const states = (s: ReturnType<typeof buildSteps>) => s.map((x) => `${x.label}:${x.state}`);

describe("buildSteps", () => {
  it("marks earlier steps done, the current running, later waiting", () => {
    expect(states(buildSteps("transcribing", "upload"))).toEqual([
      "Preparing video:done", "Transcribing:running", "Understanding context:waiting", "Indexing:waiting",
      "Finding topics:waiting", "Finding moments:waiting", "Writing the briefing:waiting",
    ]);
  });
  it("adds the download step first for YouTube; uploaded is before step 1", () => {
    expect(buildSteps("uploaded", "youtube")[0]).toMatchObject({ label: "Downloading from YouTube", state: "waiting" });
    expect(buildSteps("downloading", "youtube")[0].state).toBe("running");
  });
  it("maps the Plan 2 stages", () => {
    expect(states(buildSteps("finding_topics", "upload")).slice(3)).toEqual([
      "Indexing:done", "Finding topics:running", "Finding moments:waiting", "Writing the briefing:waiting",
    ]);
  });
});
