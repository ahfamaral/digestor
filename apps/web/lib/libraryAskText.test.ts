import { describe, expect, it } from "vitest";
import { linkifyCitations } from "./libraryAskText";

const sources = [
  { label: "S1", sessionId: "a", title: "Debate" },
  { label: "S2", sessionId: "b", title: "Interview" },
];

describe("linkifyCitations", () => {
  it("turns [S2 00:12:03] into a citation of that video at that time", () => {
    expect(linkifyCitations("Prices rose [S2 00:12:03].", sources, new Set(["a", "b"]))).toEqual([
      { kind: "text", value: "Prices rose " },
      { kind: "cite", label: "S2", time: "00:12:03", ms: 723_000, source: sources[1], live: true },
      { kind: "text", value: "." },
    ]);
  });

  it("splits a bracket with several citations, carrying the label to bare times", () => {
    const parts = linkifyCitations("Both [S1 00:01:00; S2 00:02:00, 00:03:00]", sources, new Set(["a", "b"]));
    expect(parts.filter((p) => p.kind === "cite").map((p) => p.kind === "cite" && `${p.label} ${p.time}`)).toEqual(["S1 00:01:00", "S2 00:02:00", "S2 00:03:00"]);
    expect(parts.filter((p) => p.kind === "text").map((p) => p.kind === "text" && p.value)).toEqual(["Both ", " ", " "]);
  });

  it("a source whose session is gone, or an unknown label, is not live; text without citations stays text", () => {
    const parts = linkifyCitations("See [S1 0:30] and [S9 00:00:10].", sources, new Set(["b"]));
    expect(parts[1]).toMatchObject({ kind: "cite", label: "S1", ms: 30_000, live: false, source: sources[0] });
    expect(parts[3]).toMatchObject({ kind: "cite", label: "S9", live: false, source: null });
    expect(linkifyCitations("No citations [sic].", sources, new Set())).toEqual([{ kind: "text", value: "No citations [sic]." }]);
  });

  it("with one source, a bare [hh:mm:ss] cites it", () => {
    expect(linkifyCitations("Said [00:01:00].", [sources[0]!], new Set(["a"]))[1]).toMatchObject({ kind: "cite", label: "S1", ms: 60_000, live: true });
    expect(linkifyCitations("Said [00:01:00].", sources, new Set(["a"]))).toEqual([{ kind: "text", value: "Said [00:01:00]." }]);
  });
});
