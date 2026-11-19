import { describe, expect, it } from "vitest";
import { answerBlocks, glueCitationPunctuation, linkifyCitations, notSearchedSummary } from "./libraryAskText";

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

describe("answerBlocks", () => {
  it("turns lines starting with '- ' into one list, blank lines between items allowed", () => {
    const text = "Two videos discuss it.\n\n- First point [S1 00:01:00].\n\n- Second point.\n\nI couldn't confirm: x";
    expect(answerBlocks(text)).toEqual([
      { kind: "text", text: "Two videos discuss it." },
      { kind: "list", items: ["First point [S1 00:01:00].", "Second point."] },
      { kind: "text", text: "I couldn't confirm: x" },
    ]);
  });
  it("keeps paragraphs and their own line breaks", () => {
    expect(answerBlocks("One\nstill one\n\nTwo")).toEqual([
      { kind: "text", text: "One\nstill one" },
      { kind: "text", text: "Two" },
    ]);
  });
  it("accepts '* ' and '• ' and never treats a dash inside a line as a list", () => {
    expect(answerBlocks("* a\n• b")).toEqual([{ kind: "list", items: ["a", "b"] }]);
    expect(answerBlocks("2010-2014 - a span")).toEqual([{ kind: "text", text: "2010-2014 - a span" }]);
  });
});

describe("glueCitationPunctuation", () => {
  it("moves the punctuation after a citation onto it, without the space before it", () => {
    const parts = glueCitationPunctuation(linkifyCitations("routes continue [S1 00:24:44].; C asked [S2 00:01:00] , then", sources, new Set(["a", "b"])));
    expect(parts.map((p) => (p.kind === "text" ? p.value : `<${p.label} ${p.time}${"trailing" in p ? `|${p.trailing}` : ""}>`))).toEqual([
      "routes continue ",
      "<S1 00:24:44|.;>",
      " C asked ",
      "<S2 00:01:00|,>",
      " then",
    ]);
  });
  it("leaves a citation followed by words or another citation alone", () => {
    const parts = glueCitationPunctuation(linkifyCitations("[S1 00:01:00, S1 00:02:00] and more", sources, new Set(["a"])));
    expect(parts.filter((p) => "trailing" in p)).toHaveLength(0);
    expect(parts.at(-1)).toEqual({ kind: "text", value: " and more" });
  });
});

describe("notSearchedSummary", () => {
  const v = (sessionId: string, reason: "awaiting_context" | "processing" | "removed" | "unavailable") => ({ sessionId, title: `Video ${sessionId}`, reason });

  it("counts the videos by reason in one line, and lists each with its reason", () => {
    const out = notSearchedSummary({
      retentionDays: 14,
      videos: [v("a", "processing"), v("b", "awaiting_context"), v("c", "removed"), v("d", "awaiting_context")],
    });
    expect(out?.line).toBe(
      "Not searched: 2 videos still waiting for your context answers, 1 older than 14 days (search ends 14 days after upload), 1 still processing.",
    );
    expect(out?.items).toEqual([
      { sessionId: "b", title: "Video b", reason: "waiting for your context answers" },
      { sessionId: "d", title: "Video d", reason: "waiting for your context answers" },
      { sessionId: "c", title: "Video c", reason: "older than 14 days" },
      { sessionId: "a", title: "Video a", reason: "still processing" },
    ]);
  });

  it("says video or videos on the first count only, and names a missing index plainly", () => {
    expect(notSearchedSummary({ retentionDays: 30, videos: [v("a", "unavailable")] })?.line).toBe("Not searched: 1 video can't be searched right now.");
    expect(notSearchedSummary({ retentionDays: 30, videos: [v("a", "removed"), v("b", "removed"), v("c", "unavailable")] })?.line).toBe(
      "Not searched: 2 videos older than 30 days (search ends 30 days after upload), 1 can't be searched right now.",
    );
  });

  it("shows nothing when every video was searched, or for an answer stored before this was recorded", () => {
    expect(notSearchedSummary({ retentionDays: 14, videos: [] })).toBeNull();
    expect(notSearchedSummary(null)).toBeNull();
  });
});
