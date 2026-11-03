import { describe, expect, it } from "vitest";
import { formatLength, formatTimestamp, InvalidTimestampError, parseTimestamp } from "./time.ts";

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

describe("formatLength", () => {
  it("shows seconds, minutes and seconds, or hours and minutes", () => {
    expect(formatLength(25_400)).toBe("25s");
    expect(formatLength(160_000)).toBe("2m 40s");
    expect(formatLength(120_000)).toBe("2m");
    expect(formatLength(4_320_000)).toBe("1h 12m");
    expect(formatLength(3_600_000)).toBe("1h");
    expect(formatLength(0)).toBe("0s");
  });
});

describe("parseTimestamp field ranges", () => {
  it("rejects minutes or seconds of 60 and over when a larger field precedes them", () => {
    for (const bad of ["99:99:99", "01:60:00", "05:60", "00:00:99", "1:75:00"]) expect(() => parseTimestamp(bad)).toThrow(InvalidTimestampError);
    expect(parseTimestamp("59:59")).toBe(3_599_000);
    expect(parseTimestamp("100:59:59")).toBe(100 * 3_600_000 + 59 * 60_000 + 59_000);
  });
});
