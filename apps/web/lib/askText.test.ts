import { describe, expect, it } from "vitest";
import { asToolCalls, formatToolCall, linkifyTimestamps, parseBulkPayload } from "./askText";

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

describe("parseBulkPayload", () => {
  it("reads momentIds and status", () => {
    expect(parseBulkPayload({ momentIds: ["a", "b"], status: "rejected" })).toEqual({ momentIds: ["a", "b"], status: "rejected" });
    expect(parseBulkPayload({ momentIds: ["a"], status: null })).toEqual({ momentIds: ["a"], status: null });
    expect(parseBulkPayload({ momentIds: "a" })).toBeNull();
    expect(parseBulkPayload(undefined)).toBeNull();
  });
});
