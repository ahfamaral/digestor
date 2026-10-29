import { describe, expect, it } from "vitest";
import {
  approvedClips,
  buildClipTree,
  countByFilter,
  filterClips,
  flattenTree,
  formatDuration,
  renderInProgress,
  keyToAction,
  type ClipNode,
  type ReviewClip,
} from "./review";

let n = 0;
function clip(over: Partial<ReviewClip> = {}): ReviewClip {
  n += 1;
  return {
    id: `c${n}`,
    sessionId: "s",
    parentId: null,
    title: `Clip ${n}`,
    label: "heated",
    score: 50,
    reason: "r",
    startMs: 0,
    endMs: 60_000,
    status: "proposed",
    origin: "ai",
    outOfBounds: false,
    thumbKey: null,
    renderStatus: "none",
    ...over,
  };
}
const node = (parent: ReviewClip, children: ReviewClip[] = []): ClipNode => ({ ...parent, children });

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
});

// p1 approved heated (kids: neutral heated, proposed light) · p2 neutral key_point ·
// p3 rejected light (kid: approved key_point) · p4 proposed key_point
const p1 = clip({ label: "heated", status: "approved" });
const k1a = clip({ parentId: p1.id, label: "heated", status: "neutral" });
const k1b = clip({ parentId: p1.id, label: "light" });
const p2 = clip({ label: "key_point", status: "neutral" });
const p3 = clip({ label: "light", status: "rejected" });
const k3 = clip({ parentId: p3.id, label: "key_point", status: "approved" });
const p4 = clip({ label: "key_point" });
const tree: ClipNode[] = [node(p1, [k1a, k1b]), node(p2), node(p3, [k3]), node(p4)];
const ids = (t: ClipNode[]) => t.map((c) => [c.id, c.children.map((k) => k.id)]);

describe("filterClips", () => {
  it("all hides neutral and rejected clips, parents and hot takes alike", () => {
    const out = filterClips(tree, "all");
    expect(out.some((c) => c.status === "neutral")).toBe(false);
    expect(flattenTree(out).some((c) => c.status === "neutral" || c.status === "rejected")).toBe(false);
    // a matching hot take of a hidden parent is shown on its own, where the parent was
    expect(ids(out)).toEqual([
      [p1.id, [k1b.id]],
      [k3.id, []],
      [p4.id, []],
    ]);
  });
  it("label filters keep visible clips with that label", () => {
    expect(ids(filterClips(tree, "heated"))).toEqual([[p1.id, []]]);
    expect(ids(filterClips(tree, "key_point"))).toEqual([
      [k3.id, []],
      [p4.id, []],
    ]);
    expect(ids(filterClips(tree, "light"))).toEqual([[k1b.id, []]]);
  });
  it("rejected shows rejected clips so a rejection can be undone", () => {
    expect(ids(filterClips(tree, "rejected"))).toEqual([[p3.id, []]]);
  });
  it("approved and neutral filter by status", () => {
    expect(ids(filterClips(tree, "approved"))).toEqual([
      [p1.id, []],
      [k3.id, []],
    ]);
    expect(ids(filterClips(tree, "neutral"))).toEqual([
      [k1a.id, []],
      [p2.id, []],
    ]);
  });
});

describe("countByFilter", () => {
  it("counts every clip (parents and hot takes) each filter shows", () => {
    expect(countByFilter(tree)).toEqual({ all: 4, heated: 1, key_point: 2, light: 1, approved: 2, neutral: 2, rejected: 1 });
    expect(countByFilter([])).toEqual({ all: 0, heated: 0, key_point: 0, light: 0, approved: 0, neutral: 0, rejected: 0 });
  });
});

describe("flattenTree", () => {
  it("lists each parent followed by its hot takes", () => {
    expect(flattenTree(tree).map((c) => c.id)).toEqual([p1.id, k1a.id, k1b.id, p2.id, p3.id, k3.id, p4.id]);
  });
});

describe("approvedClips", () => {
  it("lists approved long clips and hot takes in review order, even under an unapproved parent", () => {
    expect(approvedClips(tree).map((c) => c.id)).toEqual([p1.id, k3.id]);
  });
});

describe("renderInProgress", () => {
  it("is true while the session renders or any clip is queued/rendering, false otherwise", () => {
    expect(renderInProgress("rendering", [{ renderStatus: "done" }])).toBe(true);
    expect(renderInProgress("done", [{ renderStatus: "done" }, { renderStatus: "queued" }])).toBe(true);
    expect(renderInProgress("done", [{ renderStatus: "rendering" }])).toBe(true);
    expect(renderInProgress("done", [{ renderStatus: "done" }, { renderStatus: "stale" }, { renderStatus: "failed" }])).toBe(false);
  });
});

describe("buildClipTree", () => {
  it("groups children under their parent and keeps orphans top-level", () => {
    const a = clip();
    const a1 = clip({ parentId: a.id });
    const b = clip();
    const orphan = clip({ parentId: "gone" });
    const out = buildClipTree([a, a1, b, orphan]);
    expect(ids(out)).toEqual([
      [a.id, [a1.id]],
      [b.id, []],
      [orphan.id, []],
    ]);
  });
});

describe("formatDuration", () => {
  it("formats m:ss under an hour and h:mm:ss above", () => {
    expect(formatDuration(440_000)).toBe("7:20");
    expect(formatDuration(24_400)).toBe("0:24");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
  });
});
