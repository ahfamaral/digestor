import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HasVideoProvider } from "@/components/HasVideo";
import { WhosWho } from "./WhosWho";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const empty = (hasVideo?: boolean) => {
  const panel = <WhosWho sessionId="s1" rows={[]} names={{ persons: [], attributions: [] }} sensitive={false} mode="drawer" />;
  return renderToStaticMarkup(hasVideo === undefined ? panel : <HasVideoProvider value={hasVideo}>{panel}</HasVideoProvider>);
};

describe("Who's who wording", () => {
  it("an audio-only session speaks of the recording, a video session (and the default) of the video", () => {
    expect(empty(false)).toContain("No voices found in this recording.");
    expect(empty(true)).toContain("No voices found in this video.");
    expect(empty()).toContain("No voices found in this video.");
  });
});
