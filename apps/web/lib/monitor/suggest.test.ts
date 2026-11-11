import { describe, expect, it } from "vitest";
import { panelStatus } from "./suggest";

const s = (o: Partial<Parameters<typeof panelStatus>[0]>) => panelStatus({ q: "melch", loading: false, error: false, rows: 0, more: false, ...o });

describe("panelStatus", () => {
  it("each state", () => {
    expect(s({ q: "m" })).toBe("idle");
    expect(s({ q: " \u0000m " , loading: true })).toBe("idle");
    expect(s({ loading: true, rows: 3 })).toBe("searching");
    expect(s({ error: true })).toBe("error");
    expect(s({ rows: 0 })).toBe("none");
    expect(s({ rows: 3 })).toBe("list");
    expect(s({ rows: 8, more: true })).toBe("listMore");
  });
});
