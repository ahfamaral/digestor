import { describe, expect, it } from "vitest";
import { isUuid } from "./ids";

describe("isUuid", () => {
  it("accepts uuids of either case and rejects everything else", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuid("ABCDEF00-0000-4000-8000-00000000000A")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid("00000000-0000-4000-8000-000000000000/../x")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});
