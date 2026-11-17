import { describe, expect, it } from "vitest";
import { contentDisposition, safeBaseName } from "./subtitleFiles";

describe("safeBaseName", () => {
  it("never splits a character, so the header can always be encoded", () => {
    const name = safeBaseName(`${"a".repeat(99)}😀 rest`);
    expect(name).toBe(`${"a".repeat(99)}😀`);
    expect(() => contentDisposition(name)).not.toThrow();
  });

  it("keeps a joined emoji whole when it sits on the cut", () => {
    const family = "👨‍👩‍👧";
    expect(safeBaseName(`${"a".repeat(99)}${family}${"b".repeat(5)}`)).toBe(`${"a".repeat(99)}${family}`);
  });

  it("drops reserved characters and falls back to clip", () => {
    expect(safeBaseName('a/b:c*"d')).toBe("a b c d");
    expect(safeBaseName("  ")).toBe("clip");
  });
});
