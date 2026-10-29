import { describe, expect, it } from "vitest";
import { formatTimestamp, InvalidTimestampError, parseTimestamp } from "./time.ts";

describe("formatTimestamp", () => {
  it("formats hh:mm:ss with optional tenths", () => {
    expect(formatTimestamp(3_909_400)).toBe("01:05:09");
    expect(formatTimestamp(3_909_400, { tenths: true })).toBe("01:05:09.4");
    expect(formatTimestamp(0)).toBe("00:00:00");
  });
  it("keeps extra digits for 100+ hours and rejects negatives", () => {
    expect(formatTimestamp(100 * 3_600_000)).toBe("100:00:00");
    expect(() => formatTimestamp(-1)).toThrow();
  });
});

describe("parseTimestamp", () => {
  it("parses hh:mm:ss, hh:mm:ss.s and mm:ss", () => {
    expect(parseTimestamp("01:05:09.4")).toBe(3_909_400);
    expect(parseTimestamp("01:05:09")).toBe(3_909_000);
    expect(parseTimestamp("05:09")).toBe(309_000);
  });
  it("rejects malformed input and out-of-range parts", () => {
    expect(() => parseTimestamp("1:2:3x")).toThrow(InvalidTimestampError);
    expect(() => parseTimestamp("00:61:00")).toThrow(InvalidTimestampError);
    expect(() => parseTimestamp("00:00:60")).toThrow(InvalidTimestampError);
    expect(() => parseTimestamp("00:00:01.25")).toThrow(InvalidTimestampError);
    expect(() => parseTimestamp("")).toThrow(InvalidTimestampError);
    expect(() => parseTimestamp("42")).toThrow(InvalidTimestampError);
  });
});
