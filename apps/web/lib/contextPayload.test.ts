import { describe, expect, it } from "vitest";
import { buildContextPayload, type ContextFields } from "./contextPayload";

const original: ContextFields = {
  eventType: "interview",
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
      eventType: "panel",
      participants: [{ speakerId: "A", name: "Ann", role: " Host ", affiliation: "" }],
    };
    expect(buildContextPayload(original, edited, [])).toEqual({
      action: "continue",
      answers: [],
      cardEdits: { dateOrYear: "2021", eventType: "panel", participants: [{ speakerId: "A", role: "Host" }] },
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
});
