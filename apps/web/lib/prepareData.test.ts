import { describe, expect, it } from "vitest";
import type { MomentChecks } from "@digestor/core";
import { mergePairs, approvalDismissed, undoStep, checkWarnings, defaultCredit, subtitleLanguages, toClipView, toTrackView, checksStatus, checksToPoll, sharedValue, applyToAll, languageTargets, clipStatus, insideClip, withOpen, noSubtitlesInVideo } from "./prepareData";

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

describe("undoStep", () => {
  type Kind = "create" | "bounds" | "format" | "style" | "delete" | "merge" | "update" | "replace";
  const ev = (kind: Kind, undone = false, before: unknown = null) => ({ kind, undoneAt: undone ? new Date() : null, before });

  it("names the latest change still standing, and never the clip's creation", () => {
    expect(undoStep([])).toBeNull();
    expect(undoStep([ev("create")])).toBeNull();
    expect(undoStep([ev("create"), ev("bounds")])).toEqual({ kind: "bounds" });
    expect(undoStep([ev("create"), ev("bounds", true)])).toBeNull();
    expect(undoStep([ev("create"), ev("format"), ev("bounds", true)])).toEqual({ kind: "format" });
    expect(undoStep([ev("create"), ev("style")])).toEqual({ kind: "style" });
  });

  it("Prepare's undo labels an Ask update or replace as Ask's change", () => {
    expect(undoStep([ev("update")])).toEqual({ kind: "ask" });
    expect(undoStep([ev("create"), ev("replace")])).toEqual({ kind: "ask" });
  });

  it("a merge carries the range the clip goes back to", () => {
    const merge = ev("merge", false, { startMs: 10_000, endMs: 30_000, mergedMomentIds: [] });
    expect(undoStep([ev("create"), merge])).toEqual({ kind: "merge", range: { startMs: 10_000, endMs: 30_000 } });
    expect(undoStep([ev("create"), merge, ev("bounds")])).toEqual({ kind: "bounds" });
    expect(undoStep([ev("create"), merge, ev("bounds", true)])).toEqual({ kind: "merge", range: { startMs: 10_000, endMs: 30_000 } });
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
      id: "c", sessionId: "s", ownerId: "owner", momentId: "m", mergedMomentIds: [] as string[], startMs: 1, endMs: 2, format: "9:16" as const, cropOffset: 0.5, subtitleStyle: "yellow" as const, subtitlePosition: "bottom" as const, subtitleHighlight: false,
      credit: null, noCreditNeeded: false, creditSetAt: null, warningsAck: true, protectedAck: false, renderStatus: "none" as const, renderKey: null, audioKey: null, editVersion: 0,
      deletedAt: null, createdAt: at, updatedAt: at,
    };
    const fromRow = toClipView(clip);
    expect(toClipView(JSON.parse(JSON.stringify(clip)))).toEqual(fromRow);
    expect(fromRow).toEqual({
      id: "c", startMs: 1, endMs: 2, format: "9:16", cropOffset: 0.5, subtitleStyle: "yellow", subtitlePosition: "bottom", subtitleHighlight: false, credit: null, noCreditNeeded: false, warningsAck: true,
      protectedAck: false, midSentence: false, updatedAt: "2026-10-30T10:00:00.000Z",
    });
    expect(toClipView({ ...clip, midSentence: true }).midSentence).toBe(true);

    const track = {
      id: "t", clipId: "c", language: "de", status: "ready" as const, cues: [], approvedAt: at, burnStatus: "stale" as const,
      burnKey: "k", srtKey: null, vttKey: null, error: null, builtStartMs: 1, builtEndMs: 2,
    };
    expect(toTrackView(JSON.parse(JSON.stringify(track)))).toEqual(toTrackView(track));
    expect(toTrackView(track)).toEqual({
      id: "t", language: "de", status: "ready", cues: [], approved: true, burnStatus: "stale", burnBuilt: true, error: null,
    });
  });
});

describe("checksStatus (R11, R28)", () => {
  const checks = {
    argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
  };
  it("checking until a minute passed, then failed; checks for another cut say so", () => {
    expect(checksStatus({ checks: null, originalCut: false, timedOut: false })).toBe("checking");
    expect(checksStatus({ checks: null, originalCut: false, timedOut: true })).toBe("failed");
    expect(checksStatus({ checks: null, originalCut: true, timedOut: false })).toBe("originalCut");
    expect(checksStatus({ checks, originalCut: false, timedOut: true })).toBe("checked");
  });
});

describe("checksToPoll", () => {
  const items = [
    { id: "a", checks: null },
    { id: "b", checks: null },
    { id: "c", checks: { argumentComplete: true } },
  ];
  it("polls clips without checks until they time out; Check again polls that clip again", () => {
    expect(checksToPoll(items, false, {})).toEqual(["a", "b"]);
    expect(checksToPoll(items, true, {})).toEqual([]);
    expect(checksToPoll(items, true, { b: true })).toEqual(["b"]);
  });
});

describe("approvalDismissed", () => {
  const c = (momentId: string | null, mergedMomentIds: string[] = []) => ({ momentId, mergedMomentIds });
  it("never labels a clip without a moment", () => expect(approvalDismissed(c(null), {})).toBe(false));
  it("is false while the moment is approved", () => expect(approvalDismissed(c("m1"), { m1: "approved" })).toBe(false));
  it("is true when the moment was skipped", () => expect(approvalDismissed(c("m1"), { m1: "rejected" })).toBe(true));
  it("is true when the moment is undecided", () => expect(approvalDismissed(c("m1"), {})).toBe(true));
  it("is false while every merged moment is approved", () =>
    expect(approvalDismissed(c("a", ["b"]), { a: "approved", b: "approved" })).toBe(false));
  it("is true when a merged moment was skipped", () =>
    expect(approvalDismissed(c("a", ["b"]), { a: "approved", b: "rejected" })).toBe(true));
  it("is true when a merged moment is undecided", () =>
    expect(approvalDismissed(c("a", ["b"]), { a: "approved" })).toBe(true));
  it("looks at merged moments of a clip without its own moment", () =>
    expect(approvalDismissed(c(null, ["b"]), {})).toBe(true));
});

describe("mergePairs", () => {
  const c = (startMs: number, endMs: number) => ({ startMs, endMs });
  const pairs = (...cs: { startMs: number; endMs: number }[]) => [...mergePairs(cs)];
  it("offers partial overlaps and touching clips, never a gap", () => {
    expect(pairs(c(0, 60), c(50, 90))).toEqual([[0, 0]]);
    expect(pairs(c(0, 60), c(60, 90))).toEqual([[0, 0]]);
    expect(pairs(c(0, 60), c(65, 90))).toEqual([]);
    expect(pairs(c(0, 10), c(5, 20), c(15, 30))).toEqual([[0, 0], [1, 1]]);
    expect(pairs(c(0, 10))).toEqual([]);
    expect(pairs()).toEqual([]);
  });
  it("never offers a clip inside the other: later one inside, same end, same start", () => {
    expect(pairs(c(0, 100), c(10, 20))).toEqual([]);
    expect(pairs(c(0, 60), c(30, 60))).toEqual([]);
    expect(pairs(c(0, 30), c(0, 60))).toEqual([]);
    expect(pairs(c(0, 60), c(0, 60))).toEqual([]);
  });
  it("a clip nested inside an earlier one doesn't hide that one's pair with the next clip", () => {
    // 1 (0–60) holds 2 (10–20); 3 (50–90) overlaps 1 partly: the button sits between 2 and 3 and merges 1 and 3
    expect(pairs(c(0, 60), c(10, 20), c(50, 90))).toEqual([[1, 0]]);
    // 2 and 3 overlap each other but both sit inside 1: merging them would still be inside 1
    expect(pairs(c(0, 60), c(10, 20), c(15, 30))).toEqual([]);
    // after a gap the furthest-reaching clip starts over
    expect(pairs(c(0, 60), c(10, 20), c(70, 80), c(75, 90))).toEqual([[2, 2]]);
  });
});

describe("For all clips", () => {
  const c = (id: string, over: Partial<{ credit: string | null; format: "16:9" | "9:16"; noCreditNeeded: boolean; frozen: boolean }> = {}) => ({
    id, credit: null as string | null, format: "16:9" as const, noCreditNeeded: false, ...over,
  });

  it("sharedValue: the value most clips share (ties: the earliest clip's) and who differs", () => {
    const clips = [c("a", { credit: "X" }), c("b", { credit: "Y" }), c("c", { credit: "Y" }), c("d", { credit: "X" })];
    expect(sharedValue(clips, "credit")).toEqual({ value: "X", differs: ["b", "c"] });
    expect(sharedValue([c("a", { credit: "X" }), c("b", { credit: "Y" }), c("c", { credit: "Y" })], "credit")).toEqual({ value: "Y", differs: ["a"] });
    expect(sharedValue([c("a"), c("b", { credit: "  " })], "credit")).toEqual({ value: "", differs: [] });
    expect(sharedValue([c("a", { format: "9:16" }), c("b")], "format")).toEqual({ value: "9:16", differs: ["b"] });
    expect(sharedValue([], "format")).toEqual({ value: null, differs: [] });
  });

  it("a clip marked 'no credit needed' counts as differing", () => {
    expect(sharedValue([c("a", { credit: "X" }), c("b", { noCreditNeeded: true })], "credit")).toEqual({ value: "X", differs: ["b"] });
  });

  it("applyToAll: only clips on the old shared value, never frozen or no-credit clips", () => {
    const clips = [c("a", { credit: "X" }), c("b", { credit: "Y" }), c("d", { credit: "X", frozen: true }), c("e", { credit: "X", noCreditNeeded: true })];
    expect(applyToAll(clips, "credit", "X")).toEqual(["a"]);
    expect(applyToAll([c("a"), c("b", { format: "9:16" })], "format", "16:9")).toEqual(["a"]);
    expect(applyToAll([], "format", "16:9")).toEqual([]);
    // the value is already the shared one: nothing to change
    expect(applyToAll([c("a"), c("b")], "format", "16:9", "16:9")).toEqual([]);
    expect(applyToAll([c("a", { credit: "X" })], "credit", "X", "X")).toEqual([]);
  });

  it("languageTargets: adding a language touches only clips without it (and not frozen ones)", () => {
    const clips = [
      { id: "a", languages: ["de"] },
      { id: "b", languages: ["pt", "de"] },
      { id: "c", languages: [], frozen: true },
      { id: "d", languages: [] },
    ];
    expect(languageTargets(clips, "pt")).toEqual(["a", "d"]);
  });
});

describe("clipStatus", () => {
  it("is ready when every checklist item holds", () => {
    expect(clipStatus([{ id: "checks", ok: true }, { id: "speaker", ok: true }])).toEqual({ ready: true });
  });
  it("counts the items still to do", () => {
    expect(clipStatus([{ id: "checks", ok: false }, { id: "speaker", ok: true }, { id: "credit", ok: false }])).toEqual({ ready: false, todo: 2 });
  });
  it("is ready for an empty checklist", () => {
    expect(clipStatus([])).toEqual({ ready: true });
  });
});

describe("insideClip", () => {
  it("gives the number (1-based, list order) of the clip that fully contains each clip", () => {
    const clips = [
      { startMs: 0, endMs: 100_000 },
      { startMs: 10_000, endMs: 20_000 },
      { startMs: 90_000, endMs: 120_000 },
      { startMs: 200_000, endMs: 210_000 },
    ];
    expect(insideClip(clips)).toEqual([null, 1, null, null]);
  });
  it("takes the tightest container", () => {
    const clips = [
      { startMs: 0, endMs: 100_000 },
      { startMs: 10_000, endMs: 50_000 },
      { startMs: 20_000, endMs: 30_000 },
    ];
    expect(insideClip(clips)).toEqual([null, 1, 2]);
  });
  it("a clip sharing an edge counts as inside; partial overlap does not", () => {
    expect(insideClip([{ startMs: 0, endMs: 50_000 }, { startMs: 0, endMs: 20_000 }, { startMs: 40_000, endMs: 60_000 }])).toEqual([null, 1, null]);
  });
});

describe("withOpen", () => {
  it("opens the card even when it was closed by hand, and leaves the others alone", () => {
    expect(withOpen({ a: false, b: false }, "a")).toEqual({ a: true, b: false });
    expect(withOpen({}, "c")).toEqual({ c: true });
  });
});

describe("noSubtitlesInVideo", () => {
  it("is true with no tracks, or only drafts that aren't burned in", () => {
    expect(noSubtitlesInVideo([])).toBe(true);
    expect(noSubtitlesInVideo([{ burnStatus: "none", status: "ready" }])).toBe(true);
  });
  it("is false once a language is put in the video, or a track is out of date", () => {
    expect(noSubtitlesInVideo([{ burnStatus: "none", status: "ready" }, { burnStatus: "queued", status: "ready" }])).toBe(false);
    expect(noSubtitlesInVideo([{ burnStatus: "none", status: "outdated" }])).toBe(false);
  });
});
