import { describe, expect, it } from "vitest";
import type { Stage } from "@digestor/core";
import { buildSteps, STAGE_STEP } from "./processingSteps";

const states = (s: ReturnType<typeof buildSteps>) => s.map((x) => `${x.label}:${x.state}`);

describe("processing steps follow the new stages", () => {
  it("lists the ten steps in order, all waiting before anything runs", () => {
    expect(states(buildSteps("uploaded", "upload"))).toEqual([
      "Uploading:running", "Transcribing:waiting", "Understanding context:waiting", "Naming speakers:waiting", "Indexing:waiting",
      "Finding topics:waiting", "Finding moments:waiting", "Writing briefing:waiting", "Preparing the video for playback:waiting", "Ready:waiting",
    ]);
  });
  it("marks earlier steps done, the current running, later waiting", () => {
    expect(states(buildSteps("finding_topics", "upload"))).toEqual([
      "Uploading:done", "Transcribing:done", "Understanding context:done", "Naming speakers:done", "Indexing:done",
      "Finding topics:running", "Finding moments:waiting", "Writing briefing:waiting", "Preparing the video for playback:waiting", "Ready:waiting",
    ]);
  });
  it("preparing_preview is the step after Writing briefing: everything before it is done", () => {
    expect(states(buildSteps("preparing_preview", "upload"))).toEqual([
      "Uploading:done", "Transcribing:done", "Understanding context:done", "Naming speakers:done", "Indexing:done",
      "Finding topics:done", "Finding moments:done", "Writing briefing:done", "Preparing the video for playback:running", "Ready:waiting",
    ]);
  });
  it("preparing belongs to the first step; ready completes every step", () => {
    expect(buildSteps("preparing", "upload")[0].state).toBe("running");
    expect(buildSteps("ready", "upload").every((s) => s.state === "done")).toBe(true);
  });
  it("YouTube sessions name the first step Downloading from YouTube", () => {
    expect(buildSteps("downloading", "youtube")[0]).toMatchObject({ label: "Downloading from YouTube", state: "running" });
  });
  it("failed shows nothing as started", () => {
    expect(buildSteps("failed", "upload").every((s) => s.state === "waiting")).toBe(true);
  });
});

describe("stage → step mapping covers every Stage", () => {
  // Exhaustive at the type level: adding a Stage without a mapping breaks the typecheck.
  const every = {
    uploaded: 0, downloading: 0, preparing: 0, transcribing: 0, naming_speakers: 0, understanding: 0, awaiting_context: 0,
    indexing: 0, finding_topics: 0, finding_moments: 0, writing_briefing: 0, preparing_preview: 0, ready: 0, failed: 0,
  } satisfies Record<Stage, 0>;
  it("has an entry for each stage", () => {
    expect(Object.keys(STAGE_STEP).sort()).toEqual(Object.keys(every).sort());
  });
  it("buildSteps handles every stage", () => {
    for (const stage of Object.keys(every) as Stage[]) expect(buildSteps(stage, "upload")).toHaveLength(10);
  });
});

describe("audio-only sessions", () => {
  it("have no Naming speakers step (caption reading is skipped)", () => {
    const steps = buildSteps("indexing", "upload", false);
    expect(steps.map((s) => s.label)).not.toContain("Naming speakers");
    expect(steps).toHaveLength(9);
    expect(steps.find((s) => s.label === "Indexing")?.state).toBe("running");
    expect(buildSteps("ready", "upload", false).every((s) => s.state === "done")).toBe(true);
  });
  it("keep the step for video sessions, and by default", () => {
    expect(buildSteps("indexing", "upload", true).map((s) => s.label)).toContain("Naming speakers");
    expect(buildSteps("indexing", "upload").map((s) => s.label)).toContain("Naming speakers");
  });
});
