import { describe, expect, it } from "vitest";
import type { MomentWithHighlights } from "@digestor/core";
import type { MomentView } from "./briefingFilters";
import {
  actionForKey, approvedMomentIds, asClipStatus, asSelection, flattenViews, keyToAction, moveFocus, resolveFocus, type KeyInput,
} from "./review";

let n = 0;
function moment(over: Partial<MomentWithHighlights> = {}): MomentWithHighlights {
  n += 1;
  return {
    id: `m${n}`, analysisId: "a", topicId: "t", granularity: "exchange", startMs: n * 1000, endMs: n * 1000 + 60_000, title: `Moment ${n}`,
    why: "w", relevance: 50, speakers: ["A"], insideMomentId: null, evidence: [], checks: null, thumbKey: null, ownerId: null,
    origin: "ai", highlights: [], ...over,
  };
}
const view = (m: MomentWithHighlights, children: MomentView[] = []): MomentView => ({ moment: m, status: null, children });

describe("keyToAction", () => {
  it("maps the triage keys (letters case-insensitive)", () => {
    expect(keyToAction("a")).toBe("approve");
    expect(keyToAction("A")).toBe("approve");
    expect(keyToAction("n")).toBe("neutral");
    expect(keyToAction("R")).toBe("reject");
    expect(keyToAction("e")).toBe("edit");
    expect(keyToAction("ArrowDown")).toBe("next");
    expect(keyToAction("ArrowUp")).toBe("prev");
    expect(keyToAction("x")).toBeNull();
    expect(keyToAction("Enter")).toBeNull();
  });

  it("leaves / free for the Ask drawer", () => {
    expect(keyToAction("/")).toBeNull();
  });
});

describe("actionForKey", () => {
  const key = (k: string, over: Partial<KeyInput> = {}): KeyInput => ({
    key: k, repeat: false, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, ...over,
  });
  const idle = { typing: false, dialogOpen: false };

  it("returns the action for a plain key press", () => {
    expect(actionForKey(key("a"), idle)).toBe("approve");
    expect(actionForKey(key("ArrowDown"), idle)).toBe("next");
  });

  it("ignores keys while typing, in an open dialog, with modifiers, or already handled", () => {
    expect(actionForKey(key("a"), { typing: true, dialogOpen: false })).toBeNull();
    expect(actionForKey(key("a"), { typing: false, dialogOpen: true })).toBeNull();
    expect(actionForKey(key("a", { metaKey: true }), idle)).toBeNull();
    expect(actionForKey(key("a", { ctrlKey: true }), idle)).toBeNull();
    expect(actionForKey(key("a", { altKey: true }), idle)).toBeNull();
    expect(actionForKey(key("ArrowDown", { defaultPrevented: true }), idle)).toBeNull();
  });

  it("holding a status key does not triage a run of moments; arrows may repeat", () => {
    expect(actionForKey(key("a", { repeat: true }), idle)).toBeNull();
    expect(actionForKey(key("r", { repeat: true }), idle)).toBeNull();
    expect(actionForKey(key("e", { repeat: true }), idle)).toBeNull();
    expect(actionForKey(key("ArrowDown", { repeat: true }), idle)).toBe("next");
    expect(actionForKey(key("ArrowUp", { repeat: true }), idle)).toBe("prev");
  });
});

describe("flattenViews", () => {
  it("lists each moment followed by its nested moments, in display order", () => {
    const ex = moment();
    const pa = moment({ granularity: "passage" });
    const pu = moment({ granularity: "punchline" });
    const ex2 = moment();
    const tree = [view(ex, [view(pa, [view(pu)])]), view(ex2)];
    expect(flattenViews(tree).map((v) => v.moment.id)).toEqual([ex.id, pa.id, pu.id, ex2.id]);
    expect(flattenViews([])).toEqual([]);
  });
});

describe("focus", () => {
  const order = ["a", "b", "c"];

  it("moveFocus steps within the list and stops at both ends", () => {
    expect(moveFocus(order, "a", 1)).toBe("b");
    expect(moveFocus(order, "c", 1)).toBe("c");
    expect(moveFocus(order, "a", -1)).toBe("a");
    expect(moveFocus(order, null, 1)).toBe("a");
    expect(moveFocus([], null, 1)).toBeNull();
  });

  it("a focused moment that leaves the list hands focus to whatever now sits at its place", () => {
    expect(resolveFocus(order, { id: "b", index: 1 })).toBe("b");
    expect(resolveFocus(["a", "c"], { id: "b", index: 1 })).toBe("c");
    expect(resolveFocus(["a"], { id: "b", index: 1 })).toBe("a");
    expect(resolveFocus([], { id: "b", index: 1 })).toBeNull();
    expect(resolveFocus(order, { id: null, index: 0 })).toBe("a");
  });
});

describe("approvedMomentIds", () => {
  it("lists every approved moment by start time, nested or not, visible or not", () => {
    const late = moment({ startMs: 90_000 });
    const early = moment({ startMs: 10_000, granularity: "punchline" });
    const rejected = moment({ startMs: 5_000 });
    const proposed = moment({ startMs: 1_000 });
    const statuses = { [late.id]: "approved", [early.id]: "approved", [rejected.id]: "rejected" } as const;
    expect(approvedMomentIds([late, early, rejected, proposed], statuses)).toEqual([early.id, late.id]);
    expect(approvedMomentIds([late], {})).toEqual([]);
  });
});

describe("status mapping", () => {
  it("no selection row is 'proposed' for the status queue, and back", () => {
    expect(asClipStatus(null)).toBe("proposed");
    expect(asClipStatus("approved")).toBe("approved");
    expect(asSelection("proposed")).toBeNull();
    expect(asSelection("rejected")).toBe("rejected");
  });
});
