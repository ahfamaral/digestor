import { describe, expect, it } from "vitest";
import type { ToolApprovalPayload } from "@digestor/core";
import { readEdits } from "./askEdits";

const three = [
  { start: "00:01:01", end: "00:01:31", title: "One" },
  { start: "00:03:01", end: "00:03:41", title: "Two" },
  { start: "00:05:01", end: "00:05:31", title: "Three" },
];
const payload: ToolApprovalPayload = {
  step: 1,
  calls: [
    { id: "pkg", name: "make_clip_package", args: { clips: three, format: "16:9", subtitles: null }, summary: "Make 3 clips (16:9): …" },
    { id: "clip", name: "propose_clip", args: { start: "00:07:00", end: "00:07:30", title: "Four" }, summary: "Make a clip …" },
  ],
};
const ctx = { sessionLanguage: "sv" };
const edit = (args: unknown) => readEdits(payload, [{ id: "pkg", args }], ctx);

describe("readEdits: clip packages (C3)", () => {
  it("accepts picks of the card's clips with edited times and titles, a format and a subtitle language", () => {
    const args = { clips: [three[0], { ...three[2], title: " Three, edited " }], format: "9:16", subtitles: "en" };
    expect(edit(args)).toEqual([{ id: "pkg", args: { ...args, clips: [three[0], { ...three[2], title: "Three, edited" }] } }]);
  });

  it("the video's own language and no subtitles are fine too", () => {
    expect(edit({ clips: three, format: "16:9", subtitles: "sv" })).not.toBeNull();
    expect(edit({ clips: three, format: "16:9", subtitles: null })).not.toBeNull();
  });

  it.each([
    ["no clip picked", { clips: [], format: "9:16", subtitles: null }],
    ["more clips than the card offered", { clips: [...three, three[0]], format: "9:16", subtitles: null }],
    ["a clip ending before it starts", { clips: [{ start: "00:02:00", end: "00:01:00", title: "x" }], format: "9:16", subtitles: null }],
    ["a time that isn't a time", { clips: [{ start: "soon", end: "00:01:00", title: "x" }], format: "9:16", subtitles: null }],
    ["an empty title", { clips: [{ ...three[0], title: "  " }], format: "9:16", subtitles: null }],
    ["an unknown format", { clips: three, format: "1:1", subtitles: null }],
    ["a subtitle language not offered", { clips: three, format: "9:16", subtitles: "tlh" }],
    ["a missing subtitle field", { clips: three, format: "9:16" }],
    ["an extra key", { clips: three, format: "9:16", subtitles: null, burn: true }],
    ["an extra key on a clip", { clips: [{ ...three[0], momentId: "x" }], format: "9:16", subtitles: null }],
  ])("refuses %s", (_label, args) => {
    expect(edit(args)).toBeNull();
  });

  it("other tools keep their own rules", () => {
    expect(readEdits(payload, [{ id: "clip", args: { start: "00:07:00", end: "00:07:20", title: "Four" } }], ctx)).not.toBeNull();
    expect(readEdits(payload, [{ id: "clip", args: { clips: three, format: "9:16", subtitles: null } }], ctx)).toBeNull();
    expect(readEdits(payload, [{ id: "nope", args: {} }], ctx)).toBeNull();
  });
});

describe("readEdits: replace_clip", () => {
  const p: ToolApprovalPayload = {
    step: 1,
    calls: [{ id: "rep", name: "replace_clip", args: { clipId: "c", start: "00:07:00", end: "00:07:30", title: "Four" }, summary: "Replace clip 2 …" }],
  };
  it("takes start, end and title like propose_clip", () => {
    const args = { start: "00:08:00", end: "00:08:30", title: " Five " };
    expect(readEdits(p, [{ id: "rep", args }], ctx)).toEqual([{ id: "rep", args: { ...args, title: "Five" } }]);
  });
  it("rejects extra keys, a reversed range and an empty title", () => {
    expect(readEdits(p, [{ id: "rep", args: { start: "00:08:00", end: "00:08:30", title: "x", clipId: "other" } }], ctx)).toBeNull();
    expect(readEdits(p, [{ id: "rep", args: { start: "00:08:30", end: "00:08:00", title: "x" } }], ctx)).toBeNull();
    expect(readEdits(p, [{ id: "rep", args: { start: "00:08:00", end: "00:08:30", title: " " } }], ctx)).toBeNull();
  });
});
