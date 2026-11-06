import { describe, expect, it } from "vitest";
import { ASK_PENDING_LIMIT_MS, asSelectionStatus, asToolCalls, cutAtWord, formatToolCall, sourceLines, isAnswering, isStalePending, linkifyTimestamps, parseBulkPayload, planSelectionUndo } from "./askText";

describe("linkifyTimestamps", () => {
  it("splits text and times", () => {
    expect(linkifyTimestamps("He said it at [00:12:03] and again [4:05].")).toEqual([
      { kind: "text", value: "He said it at " },
      { kind: "time", ms: 723_000, label: "[00:12:03]" },
      { kind: "text", value: " and again " },
      { kind: "time", ms: 245_000, label: "[4:05]" },
      { kind: "text", value: "." },
    ]);
  });

  it("handles text with no timestamps, only a timestamp, and empty text", () => {
    expect(linkifyTimestamps("nothing here")).toEqual([{ kind: "text", value: "nothing here" }]);
    expect(linkifyTimestamps("[01:00:00]")).toEqual([{ kind: "time", ms: 3_600_000, label: "[01:00:00]" }]);
    expect(linkifyTimestamps("")).toEqual([]);
  });

  it("ignores invalid values, which stay plain text", () => {
    expect(linkifyTimestamps("at [75:00] or [00:61:00] or [12:75] or [1:2:3] or [12]")).toEqual([
      { kind: "text", value: "at [75:00] or [00:61:00] or [12:75] or [1:2:3] or [12]" },
    ]);
  });

  it("finds adjacent timestamps", () => {
    expect(linkifyTimestamps("[00:01][00:02]").map((p) => p.kind)).toEqual(["time", "time"]);
  });
});

describe("asToolCalls", () => {
  it("keeps well-formed records and drops junk", () => {
    expect(asToolCalls([{ name: "search", args: { q: "x" }, result: "3 hits", ok: true, undo: { m1: null, m2: "approved", m3: "bogus" } }, 5, { name: 1 }, null]))
      .toEqual([{ name: "search", args: { q: "x" }, result: "3 hits", ok: true, undo: { m1: null, m2: "approved" } }]);
    expect(asToolCalls(null)).toEqual([]);
  });

  it("keeps a clip id and treats an empty undo map as none", () => {
    expect(asToolCalls([{ name: "propose_clip", args: {}, result: "ok", ok: true, clipId: "c1", undo: {} }])[0]).toEqual({
      name: "propose_clip", args: {}, result: "ok", ok: true, clipId: "c1",
    });
  });
});

describe("formatToolCall", () => {
  it("shows name and compact args", () => {
    expect(formatToolCall({ name: "search_transcript", args: { query: "budget", k: 5 }, result: "", ok: true })).toBe(
      "search_transcript(query: budget, k: 5)",
    );
    expect(formatToolCall({ name: "list_topics", args: {}, result: "", ok: true })).toBe("list_topics()");
  });

  it("truncates long args and previews strings", () => {
    const long = formatToolCall({ name: "x", args: { q: "a".repeat(200) }, result: "", ok: true });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…)")).toBe(true);
    expect(formatToolCall({ name: "x", args: "raw preview", result: "", ok: true })).toBe("x(raw preview)");
  });
});

describe("asSelectionStatus", () => {
  it("reads legacy neutral and the model's skipped as rejected", () => {
    expect(asSelectionStatus("neutral")).toBe("rejected");
    expect(asSelectionStatus("skipped")).toBe("rejected");
    expect(asSelectionStatus("approved")).toBe("approved");
    expect(asSelectionStatus("maybe")).toBeNull();
  });
});

describe("parseBulkPayload", () => {
  it("accepts a stored neutral payload", () => {
    expect(parseBulkPayload({ momentIds: ["m1"], status: "neutral" })).toEqual({ momentIds: ["m1"], status: "rejected" });
  });

  it("reads momentIds and status", () => {
    expect(parseBulkPayload({ momentIds: ["a", "b"], status: "rejected" })).toEqual({ momentIds: ["a", "b"], status: "rejected" });
    expect(parseBulkPayload({ momentIds: ["a"], status: null })).toEqual({ momentIds: ["a"], status: null });
    expect(parseBulkPayload({ momentIds: "a" })).toBeNull();
    expect(parseBulkPayload(undefined)).toBeNull();
  });
});

describe("planSelectionUndo", () => {
  const call = (status: unknown, undo: Record<string, "approved" | "neutral" | "rejected" | null>) => ({ name: "set_selection", args: { momentIds: Object.keys(undo), status }, result: "", ok: true, undo: undo as Record<string, "approved" | "rejected" | null> });

  it("restores moments still at the status the tool call set", () => {
    expect(planSelectionUndo(call("approved", { a: null, b: "neutral" }), { a: "approved", b: "approved" })).toEqual({ restore: { a: null, b: "neutral" }, skipped: 0 });
  });

  it("reads a stored neutral undo target or status as skipped", () => {
    expect(planSelectionUndo(call("neutral", { a: null }), { a: "rejected" })).toEqual({ restore: { a: null }, skipped: 0 });
    expect(asToolCalls([{ name: "set_selection", args: {}, undo: { a: "neutral", b: null } }])[0]!.undo).toEqual({ a: "rejected", b: null });
  });

  it("skips moments the user changed since", () => {
    expect(planSelectionUndo(call("approved", { a: null, b: "neutral" }), { a: "approved", b: "rejected" })).toEqual({ restore: { a: null }, skipped: 1 });
  });

  it("a call that set moments back to proposed restores those still without a selection (I5)", () => {
    expect(planSelectionUndo(call("proposed", { a: "approved", b: "neutral" }), { b: "rejected" })).toEqual({ restore: { a: "approved" }, skipped: 1 });
  });

  it("treats no selection as proposed (null) and skips everything when nothing matches", () => {
    expect(planSelectionUndo(call(null, { a: "rejected" }), {})).toEqual({ restore: { a: "rejected" }, skipped: 0 });
    expect(planSelectionUndo(call("neutral", { a: null }), {})).toEqual({ restore: {}, skipped: 1 });
  });

  it("skips everything when the call's status can't be read", () => {
    expect(planSelectionUndo({ name: "set_selection", args: "garbled", result: "", ok: true, undo: { a: null } }, { a: "approved" })).toEqual({ restore: {}, skipped: 1 });
  });
});

describe("isStalePending", () => {
  const created = new Date("2026-10-30T10:00:00Z");
  it("is true once a pending answer is older than the limit", () => {
    expect(isStalePending(created.toISOString(), created.getTime() + ASK_PENDING_LIMIT_MS - 1)).toBe(false);
    expect(isStalePending(created.toISOString(), created.getTime() + ASK_PENDING_LIMIT_MS + 1)).toBe(true);
    expect(isStalePending("not a date", Date.now())).toBe(false);
  });
});

describe("isAnswering (T14)", () => {
  it("a running answer is still being worked on, like a pending one", () => {
    expect(isAnswering("pending")).toBe(true);
    expect(isAnswering("running")).toBe(true);
    expect(isAnswering("done")).toBe(false);
    expect(isAnswering("failed")).toBe(false);
  });
});

describe("sourceLines", () => {
  const rec = (name: string, result: string, extra: object = {}) => ({ name, args: {}, result, ok: true, ...extra });
  const id = "15b18bfa-9cb2-4f55-88db-bf3bbf49a477";

  it("turns tool steps into plain source lines", () => {
    const search = rec("search_transcript", "<transcript>\n[00:12:04–00:13:10] A, B: Rents rose by ten percent.\n\n[00:20:00–00:20:30] A: More.\n</transcript>");
    expect(sourceLines(search)).toEqual(["Transcript 00:12:04–00:13:10", "Transcript 00:20:00–00:20:30"]);
    const moments = rec("list_moments", `<transcript>\n${id} [00:10:00–00:10:40] exchange; relevance 90; highlights: Heated; speakers A; proposed: The clash — Sharp words.\n</transcript>`);
    expect(sourceLines(moments)).toEqual(["Moment: The clash"]);
    const transcript = rec("get_transcript", "<transcript>\n[00:01:00] A: One.\n[00:01:05] B: Two.\n[00:01:30] A: Three.\n</transcript>");
    expect(sourceLines(transcript)).toEqual(["Transcript 00:01:00–00:01:30"]);
    const topics = rec("list_topics", "[00:00:00–00:20:00] Housing — Rents.");
    expect(sourceLines(topics)).toEqual(["Topic: Housing"]);
    for (const line of [...sourceLines(search), ...sourceLines(moments), ...sourceLines(transcript)]) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(line).not.toMatch(/[<>]/);
    }
  });

  it("leaves out calls that changed something (they have Undo) and never cuts mid-word", () => {
    expect(sourceLines(rec("set_selection", "Set 2 moments to approved.", { undo: { [id]: null } }))).toEqual([]);
    expect(sourceLines(rec("propose_clip", "Clip created.", { clipId: "c" }))).toEqual([]);
    const long = `${id} [00:10:00–00:10:40] passage; highlights: Key point; proposed: ${"extraordinarily ".repeat(12)}end — why`;
    const [line] = sourceLines(rec("list_moments", `<transcript>\n${long}\n</transcript>`));
    expect(line!.endsWith("…")).toBe(true);
    expect(line!.slice(0, -1).trimEnd().split(" ").every((w, i) => i === 0 || w === "extraordinarily")).toBe(true);
    expect(cutAtWord("alpha beta gamma", 9)).toBe("alpha…");
    expect(cutAtWord("short", 9)).toBe("short");
  });

  it("a result cut by storage at 300 characters loses only the broken end of its last title", () => {
    const line = (n: number) => `${id} [00:0${n}:00–00:0${n}:40] passage; relevance 5${n}; proposed: The mayor promised cheaper housing number ${n} — why`;
    const stored = `<transcript>\n${[1, 2, 3].map(line).join("\n")}`.slice(0, 300);
    const lines = sourceLines(rec("list_moments", stored));
    expect(lines.slice(0, 2)).toEqual(["Moment: The mayor promised cheaper housing number 1", "Moment: The mayor promised cheaper housing number 2"]);
    for (const l of lines.slice(2)) expect(l).toMatch(/^Moment: The mayor promised( cheaper)?( housing)?…?$/);
  });

  it("falls back to plain text for an error result", () => {
    expect(sourceLines({ name: "get_transcript", args: {}, result: "Error: Ask for at most 10 minutes at a time.", ok: false })).toEqual(["Ask for at most 10 minutes at a time."]);
  });
});
