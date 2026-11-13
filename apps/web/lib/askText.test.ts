import { describe, expect, it } from "vitest";
import {
  ASK_PENDING_LIMIT_MS, asSelectionStatus, asToolCalls, awaitsApproval, checkClipEdit, cutAtWord, formatToolCall, initialPackageDraft, isChange, packageDecision, packageOutcome,
  sourceLines, isAnswering, isStalePending, isWorkingOn, linkifyTimestamps, parseApprovalPayload, parseBulkPayload, planSelectionUndo, verifyResult,
} from "./askText";

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

  it("a cited range plays from its start, one button for the whole range", () => {
    expect(linkifyTimestamps("five weeks there [00:04:09–00:05:06].")).toEqual([
      { kind: "text", value: "five weeks there " },
      { kind: "time", ms: 249_000, label: "[00:04:09–00:05:06]" },
      { kind: "text", value: "." },
    ]);
    expect(linkifyTimestamps("[4:09 - 5:06]")).toEqual([{ kind: "time", ms: 249_000, label: "[4:09 - 5:06]" }]);
  });

  it("a cited list gets a button per time", () => {
    expect(linkifyTimestamps("[00:01:00; 00:02:00]")).toEqual([
      { kind: "text", value: "[" },
      { kind: "time", ms: 60_000, label: "00:01:00" },
      { kind: "text", value: "; " },
      { kind: "time", ms: 120_000, label: "00:02:00" },
      { kind: "text", value: "]" },
    ]);
  });

  it("a range or list with an invalid time stays plain text", () => {
    expect(linkifyTimestamps("[00:04:09–00:75:00] [1:00; x]")).toEqual([{ kind: "text", value: "[00:04:09–00:75:00] [1:00; x]" }]);
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

describe("verifyResult", () => {
  const verify = (args: object) => ({ name: "verify_answer", args: { rounds: 0, checked: 0, unsupported: 0, unchecked: 0, judgeFailed: false, ...args }, result: "worker line", ok: true });
  const search = { name: "search_transcript", args: {}, result: "<transcript>\n[00:01:00–00:01:10] A: Hi.\n</transcript>", ok: true };

  it("reads the chip's counts into one state, never the worker's English line", () => {
    expect(verifyResult([search, verify({ checked: 3 })])).toEqual({ kind: "ok" });
    expect(verifyResult([verify({ checked: 1, unsupported: 2, judgeFailed: true })])).toEqual({ kind: "unconfirmed", n: 2 });
    expect(verifyResult([verify({ checked: 1, unchecked: 2, judgeFailed: true })])).toEqual({ kind: "failed" });
    expect(verifyResult([verify({ checked: 1, unchecked: 1 })])).toEqual({ kind: "unchecked", n: 1 });
    expect(verifyResult([{ ...verify({}), args: "garbled" }])).toBeNull();
    expect(verifyResult([{ ...verify({}), args: { rounds: 0 } }])).toBeNull();
    expect(verifyResult([search])).toBeNull();
  });

  it("is never listed as a source", () => {
    expect(sourceLines(verify({ unsupported: 1 }))).toEqual([]);
  });
});

describe("sourceLines", () => {
  const rec = (name: string, result: string, extra: object = {}) => ({ name, args: {}, result, ok: true, ...extra });
  const id = "15b18bfa-9cb2-4f55-88db-bf3bbf49a477";

  const flat = (call: ReturnType<typeof rec>) => sourceLines(call).map((l) => `${l.kind}|${l.text}`);

  it("turns tool steps into plain source lines", () => {
    const search = rec("search_transcript", "<transcript>\n[00:12:04–00:13:10] A, B: Rents rose by ten percent.\n\n[00:20:00–00:20:30] A: More.\n</transcript>");
    expect(flat(search)).toEqual(["transcript|00:12:04–00:13:10", "transcript|00:20:00–00:20:30"]);
    const moments = rec("list_moments", `<transcript>\n${id} [00:10:00–00:10:40] exchange; relevance 90; highlights: Heated; speakers A; proposed: The clash — Sharp words.\n</transcript>`);
    expect(flat(moments)).toEqual(["moment|The clash"]);
    const transcript = rec("get_transcript", "<transcript>\n[00:01:00] A: One.\n[00:01:05] B: Two.\n[00:01:30] A: Three.\n</transcript>");
    expect(flat(transcript)).toEqual(["transcript|00:01:00–00:01:30"]);
    const topics = rec("list_topics", "[00:00:00–00:20:00] Housing — Rents.");
    expect(flat(topics)).toEqual(["topic|Housing"]);
    for (const line of [...flat(search), ...flat(moments), ...flat(transcript)]) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(line).not.toMatch(/[<>]/);
    }
  });

  it("leaves out calls that changed something (they have Undo) and never cuts mid-word", () => {
    expect(sourceLines(rec("set_selection", "Set 2 moments to approved.", { undo: { [id]: null } }))).toEqual([]);
    expect(sourceLines(rec("propose_clip", "Clip created.", { clipId: "c" }))).toEqual([]);
    const long = `${id} [00:10:00–00:10:40] passage; highlights: Key point; proposed: ${"extraordinarily ".repeat(12)}end — why`;
    const line = sourceLines(rec("list_moments", `<transcript>\n${long}\n</transcript>`))[0]!.text;
    expect(line.endsWith("…")).toBe(true);
    expect(line.slice(0, -1).trimEnd().split(" ").every((w, i) => i === 0 || w === "extraordinarily")).toBe(true);
    expect(cutAtWord("alpha beta gamma", 9)).toBe("alpha…");
    expect(cutAtWord("short", 9)).toBe("short");
  });

  it("a result cut by storage at 300 characters loses only the broken end of its last title", () => {
    const line = (n: number) => `${id} [00:0${n}:00–00:0${n}:40] passage; relevance 5${n}; proposed: The mayor promised cheaper housing number ${n} — why`;
    const stored = `<transcript>\n${[1, 2, 3].map(line).join("\n")}`.slice(0, 300);
    const lines = flat(rec("list_moments", stored));
    expect(lines.slice(0, 2)).toEqual(["moment|The mayor promised cheaper housing number 1", "moment|The mayor promised cheaper housing number 2"]);
    for (const l of lines.slice(2)) expect(l).toMatch(/^moment\|The mayor promised( cheaper)?( housing)?…?$/);
  });

  it("falls back to plain text for an error result", () => {
    expect(sourceLines({ name: "get_transcript", args: {}, result: "Error: Ask for at most 10 minutes at a time.", ok: false })).toEqual([{ kind: "note", text: "Ask for at most 10 minutes at a time." }]);
  });
});

describe("tool approvals (C1)", () => {
  const card = (status: string) => ({ kind: "tool_approval" as const, status });
  it("a waiting answer with a pending card awaits approval; once decided it is being worked on again", () => {
    expect(awaitsApproval({ status: "waiting", actions: [card("pending")] })).toBe(true);
    expect(isWorkingOn({ status: "waiting", actions: [card("pending")] })).toBe(false);
    expect(awaitsApproval({ status: "waiting", actions: [card("confirmed")] })).toBe(false);
    expect(isWorkingOn({ status: "waiting", actions: [card("confirmed")] })).toBe(true);
    expect(isWorkingOn({ status: "waiting", actions: [card("dismissed"), { kind: "bulk_selection", status: "pending" }] })).toBe(true);
    expect(isWorkingOn({ status: "running", actions: [] })).toBe(true);
    expect(isWorkingOn({ status: "done", actions: [card("confirmed")] })).toBe(false);
    expect(awaitsApproval({ status: "done", actions: [card("pending")] })).toBe(false);
  });

  it("parseApprovalPayload keeps well-formed calls only", () => {
    const call = { id: "c1", name: "propose_clip", args: { title: "x" }, summary: "Make a clip", range: { startMs: 1000, endMs: 31_000 } };
    expect(parseApprovalPayload({ step: 2, calls: [call, { id: 5 }, { id: "c2", name: "set_selection", summary: "Approve 1 moment", moments: [{ id: "m", title: "T", startMs: 0, endMs: 1 }] }] })).toEqual({
      step: 2,
      calls: [call, { id: "c2", name: "set_selection", args: undefined, summary: "Approve 1 moment", moments: [{ id: "m", title: "T", startMs: 0, endMs: 1 }] }],
    });
    expect(parseApprovalPayload({ calls: "x" })).toBeNull();
    expect(parseApprovalPayload(null)).toBeNull();
  });

  it("checkClipEdit wants times as hh:mm:ss, the end after the start, and a title when asked", () => {
    expect(checkClipEdit({ start: "00:01:00", end: "00:01:30", title: "x" }, true)).toBeNull();
    expect(checkClipEdit({ start: "1:00", end: "1:30" }, false)).toBeNull();
    expect(checkClipEdit({ start: "abc", end: "00:01:30" }, false)).toBe("time");
    expect(checkClipEdit({ start: "00:01:30", end: "00:01:30" }, false)).toBe("order");
    expect(checkClipEdit({ start: "00:01:00", end: "00:01:30", title: "  " }, true)).toBe("title");
  });
});

describe("clip packages (C3)", () => {
  const plan = { clips: [{ startMs: 60_000, endMs: 90_000, title: "One" }, { startMs: 180_000, endMs: 220_000, title: "Two" }], format: "9:16" as const, subtitles: "en" };
  const pkgCall = { id: "pkg", name: "make_clip_package", args: {}, summary: "Make 2 clips (9:16)", package: plan };

  it("parseApprovalPayload keeps a package's clips, format and subtitle language, dropping junk clips", () => {
    const raw = { step: 1, calls: [{ ...pkgCall, package: { ...plan, clips: [...plan.clips, { startMs: "x" }] } }] };
    expect(parseApprovalPayload(raw)!.calls[0]!.package).toEqual(plan);
    expect(parseApprovalPayload({ step: 1, calls: [{ ...pkgCall, package: { ...plan, format: "1:1" } }] })!.calls[0]!.package).toBeUndefined();
    expect(parseApprovalPayload({ step: 1, calls: [{ ...pkgCall, package: { ...plan, subtitles: 5 } }] })!.calls[0]!.package!.subtitles).toBeNull();
  });

  it("a package's chip keeps its clip ids, is a change (Undo) and never a source", () => {
    const [rec] = asToolCalls([{ name: "make_clip_package", args: {}, result: "Created 2 clips (9:16)", ok: true, clipIds: ["a", 5, "b"] }]);
    expect(rec!.clipIds).toEqual(["a", "b"]);
    expect(isChange(rec!)).toBe(true);
    expect(sourceLines(rec!)).toEqual([]);
    expect(isChange({ ...rec!, ok: false, clipIds: undefined })).toBe(false);
  });

  it("the card approves as is when nothing changed, and sends the picks as an edit otherwise", () => {
    const draft = initialPackageDraft(plan);
    expect(draft).toEqual({
      clips: [{ on: true, start: "00:01:00", end: "00:01:30", title: "One" }, { on: true, start: "00:03:00", end: "00:03:40", title: "Two" }],
      format: "9:16",
      subtitles: "en",
    });
    expect(packageDecision("pkg", draft, draft)).toEqual({ decision: "approve" });
    const picked = { ...draft, clips: [draft.clips[0]!, { ...draft.clips[1]!, on: false }], subtitles: null };
    expect(packageDecision("pkg", picked, draft)).toEqual({
      decision: "edit",
      edits: [{ id: "pkg", args: { clips: [{ start: "00:01:00", end: "00:01:30", title: "One" }], format: "9:16", subtitles: null } }],
    });
    expect(packageDecision("pkg", { ...draft, clips: draft.clips.map((c) => ({ ...c, title: ` ${c.title} ` })) }, draft)).toEqual({ decision: "approve" });
  });

  it("the card says what's wrong: nothing picked, a bad time, the end first, no title (only picked clips count)", () => {
    const draft = initialPackageDraft(plan);
    expect(packageDecision("pkg", { ...draft, clips: draft.clips.map((c) => ({ ...c, on: false })) }, draft)).toEqual({ error: "none" });
    expect(packageDecision("pkg", { ...draft, clips: [{ ...draft.clips[0]!, start: "soon" }, draft.clips[1]!] }, draft)).toEqual({ error: "time", index: 0 });
    expect(packageDecision("pkg", { ...draft, clips: [{ ...draft.clips[0]!, end: "00:00:10" }, draft.clips[1]!] }, draft)).toEqual({ error: "order", index: 0 });
    expect(packageDecision("pkg", { ...draft, clips: [{ ...draft.clips[0]!, title: " " }, draft.clips[1]!] }, draft)).toEqual({ error: "title", index: 0 });
    expect(packageDecision("pkg", { ...draft, clips: [{ ...draft.clips[0]!, title: " " , on: false }, draft.clips[1]!] }, draft)).toEqual(
      expect.objectContaining({ decision: "edit" }),
    );
  });
});

describe("clip packages, fix round (C3)", () => {
  const plan = { clips: [{ startMs: 60_000, endMs: 90_000, title: "One" }], format: "9:16" as const, subtitles: null };

  it("a package that failed partway still offers Undo for the clips it made", () => {
    const [rec] = asToolCalls([{ name: "make_clip_package", args: {}, result: "Failed partway", ok: false, clipIds: ["a"] }]);
    expect(isChange(rec!)).toBe(true);
    expect(isChange({ ...rec!, clipIds: undefined })).toBe(false);
  });

  it("an edited clip must be 6 s to 20 min long, as the worker requires", () => {
    const draft = initialPackageDraft(plan);
    const at = (start: string, end: string) => packageDecision("pkg", { ...draft, clips: [{ ...draft.clips[0]!, start, end }] }, draft);
    expect(at("00:01:00", "00:01:05")).toEqual({ error: "length", index: 0 });
    expect(at("00:01:00", "00:21:01")).toEqual({ error: "length", index: 0 });
    expect(at("00:01:00", "00:01:06")).toEqual(expect.objectContaining({ decision: "edit" }));
  });

  it("packageOutcome reads the tool's record: how many clips were made, or that it failed", () => {
    const rec = (over: object) => asToolCalls([{ name: "make_clip_package", args: {}, result: "", ok: true, ...over }])[0]!;
    const calls = [rec({ clipIds: ["a", "b"] }), rec({ ok: false, result: "Error: x" })];
    expect(packageOutcome(calls, 0)).toEqual({ ok: true, made: 2 });
    expect(packageOutcome(calls, 1)).toEqual({ ok: false, made: 0 });
    expect(packageOutcome(calls, 2)).toBeNull();
  });
});
