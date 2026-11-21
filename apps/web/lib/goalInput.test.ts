import { describe, expect, it } from "vitest";
import { readGoalInput } from "./goalInput";

describe("readGoalInput", () => {
  it("trims, turns blank into null and refuses more than 500 characters", () => {
    expect(readGoalInput("  3 clips  ")).toEqual({ goal: "3 clips" });
    expect(readGoalInput("   ")).toEqual({ goal: null });
    expect(readGoalInput(null)).toEqual({ goal: null });
    expect(readGoalInput("x".repeat(500))).toEqual({ goal: "x".repeat(500) });
    const r = readGoalInput("x".repeat(501));
    expect("error" in r && r.error.status).toBe(400);
  });
});
