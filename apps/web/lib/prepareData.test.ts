import { describe, expect, it } from "vitest";
import type { MomentChecks } from "@digestor/core";
import { canUndo, checkWarnings, defaultCredit, subtitleLanguages, toClipView, toTrackView } from "./prepareData";

const clean: MomentChecks = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};

describe("defaultCredit", () => {
  it("uses the YouTube channel (or uploader) and leaves uploads empty", () => {
    expect(defaultCredit({ source: "youtube", metadata: { channel: "  City Radio ", uploader: "x" } })).toBe("City Radio");
    expect(defaultCredit({ source: "youtube", metadata: { channel: "", uploader: "Uploader TV" } })).toBe("Uploader TV");
    expect(defaultCredit({ source: "youtube", metadata: { channel: 42 } })).toBe("");
    expect(defaultCredit({ source: "upload", metadata: { channel: "From tags" } })).toBe("");
  });
});

describe("canUndo", () => {
  const ev = (kind: "create" | "bounds" | "format" | "delete", undone = false) => ({ kind, undoneAt: undone ? new Date() : null });

  it("is true only when the latest change still standing is an edit (never the clip's creation)", () => {
    expect(canUndo([])).toBe(false);
    expect(canUndo([ev("create")])).toBe(false);
    expect(canUndo([ev("create"), ev("bounds")])).toBe(true);
    expect(canUndo([ev("create"), ev("bounds", true)])).toBe(false);
    expect(canUndo([ev("create"), ev("format"), ev("bounds", true)])).toBe(true);
  });
});

describe("checkWarnings", () => {
  it("lists each warning the checks raise, in a fixed order", () => {
    expect(checkWarnings(clean)).toEqual([]);
    expect(
      checkWarnings({ ...clean, argumentComplete: false, continuesWith: "And then…", contextRisk: "Sarcasm", reportedSpeech: true, interpreter: true }),
    ).toEqual([
      { kind: "argument", detail: "And then…" },
      { kind: "context", detail: "Sarcasm" },
      { kind: "reportedSpeech", detail: null },
      { kind: "interpreter", detail: null },
    ]);
    expect(checkWarnings({ ...clean, argumentComplete: false })).toEqual([{ kind: "argument", detail: null }]);
  });
});

describe("subtitleLanguages", () => {
  it("offers the listed languages plus the original, minus those the clip already has", () => {
    const codes = subtitleLanguages("ca", ["en"]).map((l) => l.code);
    expect(codes[0]).toBe("ca");
    expect(codes).not.toContain("en");
    expect(codes).toContain("de");
    // the original already in the list appears once, first
    const pt = subtitleLanguages("pt", []).map((l) => l.code);
    expect(pt.filter((c) => c === "pt")).toHaveLength(1);
    expect(pt[0]).toBe("pt");
    expect(subtitleLanguages(null, []).length).toBe(13);
  });
});

describe("views", () => {
  it("turn rows and JSON responses into the same plain shape", () => {
    const at = new Date("2026-10-30T10:00:00Z");
    const clip = {
      id: "c", sessionId: "s", ownerId: "owner", momentId: "m", startMs: 1, endMs: 2, format: "9:16" as const, cropOffset: 0.5,
      credit: null, noCreditNeeded: false, warningsAck: true, protectedAck: false, renderStatus: "none" as const, renderKey: null,
      deletedAt: null, createdAt: at, updatedAt: at,
    };
    const fromRow = toClipView(clip);
    expect(toClipView(JSON.parse(JSON.stringify(clip)))).toEqual(fromRow);
    expect(fromRow).toEqual({
      id: "c", startMs: 1, endMs: 2, format: "9:16", cropOffset: 0.5, credit: null, noCreditNeeded: false, warningsAck: true,
      protectedAck: false, updatedAt: "2026-10-30T10:00:00.000Z",
    });

    const track = {
      id: "t", clipId: "c", language: "de", status: "ready" as const, cues: [], approvedAt: at, burnStatus: "stale" as const,
      burnKey: "k", srtKey: null, vttKey: null, error: null,
    };
    expect(toTrackView(JSON.parse(JSON.stringify(track)))).toEqual(toTrackView(track));
    expect(toTrackView(track)).toEqual({
      id: "t", language: "de", status: "ready", cues: [], approved: true, burnStatus: "stale", burnBuilt: true, error: null,
    });
  });
});
