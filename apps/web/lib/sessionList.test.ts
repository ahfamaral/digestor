import { describe, expect, it } from "vitest";
import { sessionStatus } from "./sessionList";

describe("sessionStatus", () => {
  it("says Ready when done", () => {
    expect(sessionStatus({ stage: "ready", error: null })).toEqual({ text: "Ready", busy: false, tone: "normal" });
  });
  it("says Waiting for you at the context check", () => {
    expect(sessionStatus({ stage: "awaiting_context", error: null })).toMatchObject({ text: "Waiting for you", busy: false, tone: "waiting" });
  });
  it("shows the Processing label with busy while working", () => {
    expect(sessionStatus({ stage: "transcribing", error: null })).toEqual({ text: "Transcribing", busy: true, tone: "normal" });
    expect(sessionStatus({ stage: "uploaded", error: null }).busy).toBe(true);
  });
  it("says Downloading for a YouTube session that is downloading", () => {
    expect(sessionStatus({ stage: "downloading", error: null, source: "youtube" })).toEqual({ text: "Downloading from YouTube", busy: true, tone: "normal" });
    expect(sessionStatus({ stage: "downloading", error: null, source: "upload" }).text).toBe("Uploading");
  });
  it("says Failed without the raw error", () => {
    const s = sessionStatus({ stage: "failed", error: "ECONNRESET at 10.0.0.1" });
    expect(s).toEqual({ text: "Failed", busy: false, tone: "failed" });
  });
});
