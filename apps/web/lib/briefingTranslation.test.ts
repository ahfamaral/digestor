import { describe, expect, it } from "vitest";
import { translationFromResponse } from "./briefingTranslation";

const content = { lead: [{ text: "Olá.", momentIds: [] }], sections: [] };
const FAILED = "Couldn't translate the briefing. Please try again.";

describe("translationFromResponse", () => {
  it("polling keeps going on 5xx and pending, fails only on a failed row or a 404", () => {
    expect(translationFromResponse("poll", 503, { error: "Couldn't queue the job." })).toEqual({ status: "pending" });
    expect(translationFromResponse("poll", 500, null)).toEqual({ status: "pending" });
    expect(translationFromResponse("poll", 200, { status: "pending" })).toEqual({ status: "pending" });
    expect(translationFromResponse("poll", 200, { status: "failed", error: "ANTHROPIC_API_KEY is not set on the server." })).toEqual({
      status: "failed",
      error: "ANTHROPIC_API_KEY is not set on the server.",
    });
    expect(translationFromResponse("poll", 200, { status: "failed" })).toEqual({ status: "failed", error: FAILED });
    expect(translationFromResponse("poll", 404, { error: "This briefing hasn't been translated yet." })).toEqual({
      status: "failed",
      error: FAILED,
    });
    expect(translationFromResponse("poll", 200, { status: "ready", content })).toEqual({ status: "ready", content });
    expect(translationFromResponse("poll", 200, { status: "ready", content: { lead: "x" } })).toEqual({ status: "failed", error: FAILED });
  });

  it("a request answers ready, pending, or the API's own sentence", () => {
    expect(translationFromResponse("request", 200, { status: "ready", content })).toEqual({ status: "ready", content });
    expect(translationFromResponse("request", 202, { status: "pending" })).toEqual({ status: "pending" });
    expect(translationFromResponse("request", 409, { error: "This briefing isn't ready yet." })).toEqual({
      status: "failed",
      error: "This briefing isn't ready yet.",
    });
    expect(translationFromResponse("request", 503, { error: "Couldn't queue the job. Please try again." })).toEqual({
      status: "failed",
      error: "Couldn't queue the job. Please try again.",
    });
  });
});
