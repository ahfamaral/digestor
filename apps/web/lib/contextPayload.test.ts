import { describe, expect, it } from "vitest";
import { ResumePayloadSchema } from "@digestor/core";
import { buildContextPayload, type ContextFields } from "./contextPayload";

const original: ContextFields = {
  profile: "interview",
  language: "en",
  title: "Talk",
  setting: "Studio",
  dateOrYear: "",
  participants: [{ speakerId: "A", name: "Ann", role: "", affiliation: "" }],
};

describe("buildContextPayload", () => {
  it("sends no edits when nothing changed", () => {
    expect(buildContextPayload(original, original, [])).toEqual({ action: "continue", answers: [], cardEdits: {} });
  });
  it("includes only changed fields, trimmed", () => {
    const edited: ContextFields = {
      ...original,
      dateOrYear: "  2021 ",
      profile: "trial",
      participants: [{ speakerId: "A", name: "Ann", role: " Host ", affiliation: "" }],
    };
    expect(buildContextPayload(original, edited, [])).toEqual({
      action: "continue",
      answers: [],
      cardEdits: { dateOrYear: "2021", profile: "trial", participants: [{ speakerId: "A", role: "Host" }] },
    });
  });
  it("treats a whitespace-only change as unchanged", () => {
    expect(buildContextPayload(original, { ...original, title: " Talk " }, []).cardEdits).toEqual({});
  });
  it("drops empty answers and trims the rest", () => {
    const p = buildContextPayload(original, original, [
      { questionId: "q1", answer: "  " },
      { questionId: "q2", answer: " 2019 " },
    ]);
    expect(p.answers).toEqual([{ questionId: "q2", answer: "2019" }]);
  });
  it("never sends a blanked field (the worker cannot clear facts)", () => {
    const edited: ContextFields = {
      ...original,
      title: "  ",
      participants: [{ speakerId: "A", name: "", role: "", affiliation: "" }],
    };
    expect(buildContextPayload(original, edited, []).cardEdits).toEqual({});
  });
  it("produces a payload ResumePayloadSchema accepts", () => {
    const edited: ContextFields = { ...original, profile: "trial", dateOrYear: "2020" };
    const p = buildContextPayload(original, edited, [{ questionId: "q", answer: "x" }]);
    expect(ResumePayloadSchema.safeParse(p).success).toBe(true);
  });
});
