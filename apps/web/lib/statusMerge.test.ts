import { describe, expect, it } from "vitest";
import { OVERLAY_GRACE_MS, displayStatuses, reconcileOverlay, type StatusOverlay } from "./statusMerge";

describe("displayStatuses", () => {
  it("shows the server's statuses with this visit's clicks on top (null = back to undecided)", () => {
    const overlay: StatusOverlay = { a: { status: "rejected", confirmedAt: null }, b: { status: null, confirmedAt: 5 } };
    expect(displayStatuses({ a: "approved", b: "approved", c: "approved" }, overlay)).toEqual({ a: "rejected", c: "approved" });
  });

  it("a moment Ask added and approved shows as soon as the refreshed data has it", () => {
    expect(displayStatuses({ ask1: "approved" }, {})).toEqual({ ask1: "approved" });
  });
});

describe("reconcileOverlay", () => {
  const now = 100_000;

  it("keeps a click whose write is still in flight, even when the refreshed snapshot says otherwise", () => {
    const overlay: StatusOverlay = { a: { status: "approved", confirmedAt: null } };
    expect(reconcileOverlay(overlay, {}, now)).toBe(overlay);
  });

  it("keeps a click accepted moments ago against a snapshot that may predate it", () => {
    const overlay: StatusOverlay = { a: { status: "approved", confirmedAt: now - 500 } };
    expect(reconcileOverlay(overlay, {}, now)).toBe(overlay);
  });

  it("drops a click the server now agrees with", () => {
    const overlay: StatusOverlay = { a: { status: "approved", confirmedAt: now - 500 }, b: { status: null, confirmedAt: null } };
    expect(reconcileOverlay(overlay, { a: "approved" }, now)).toEqual({});
  });

  it("lets a later change from elsewhere (Ask) win once the grace has passed", () => {
    const overlay: StatusOverlay = { a: { status: "approved", confirmedAt: now - OVERLAY_GRACE_MS } };
    const next = reconcileOverlay(overlay, { a: "rejected" }, now);
    expect(next).toEqual({});
    expect(displayStatuses({ a: "rejected" }, next)).toEqual({ a: "rejected" });
  });

  it("a click back to undecided agrees with a snapshot that has no selection", () => {
    expect(reconcileOverlay({ a: { status: null, confirmedAt: now } }, {}, now)).toEqual({});
  });
});
