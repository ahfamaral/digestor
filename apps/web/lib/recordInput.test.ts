import { describe, expect, it } from "vitest";
import { readRecordInput } from "./recordInput";

describe("readRecordInput: future dates", () => {
  it("answers 400 with the future-date line for a typed date more than a day ahead", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const read = readRecordInput(future, "senado");
    if (!("error" in read)) throw new Error("expected an error");
    expect(read.error.status).toBe(400);
    expect(await read.error.json()).toMatchObject({ error: "That date is in the future. Check the date." });
  });
  it("takes today", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(readRecordInput(today, "senado")).toMatchObject({ ref: { chamber: "senado", date: today } });
  });
});
