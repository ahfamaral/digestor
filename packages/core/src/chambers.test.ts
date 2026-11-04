import { describe, expect, it } from "vitest";
import { CHAMBER_IDS, CHAMBERS, chamberLabel, chamberThresholds } from "./chambers.ts";

describe("chambers", () => {
  it("lists the five houses in display order", () => {
    expect(CHAMBER_IDS).toEqual(["camara", "senado", "bundestag", "us_house", "us_senate"]);
    expect(CHAMBERS.bundestag.publishWindowDays).toBe(21);
    expect(CHAMBERS.us_house.idSystem).toBe("bioguide");
  });
  it("uses Infinity as confirm threshold for a house that is not evaluated", () => {
    expect(chamberThresholds("us_senate").confirm).toBe(Infinity);
    expect(chamberThresholds("us_senate").propose).toBe(0.35);
  });
  it("uses each evaluated house's tuned thresholds (Task 12 eval, 2026-11-04)", () => {
    expect(chamberThresholds("senado")).toEqual({ confirm: 0.6, propose: 0.35 });
    expect(chamberThresholds("bundestag")).toEqual({ confirm: 0.6, propose: 0.35 });
    // The reading clerk (0.78) and the chair's "recognized for N minutes" (0.71, 0.75) match a member's speech text.
    expect(chamberThresholds("us_house")).toEqual({ confirm: 0.8, propose: 0.35 });
  });
  it("labels houses", () => {
    expect(chamberLabel("us_house")).toBe("House (USA)");
    expect(chamberLabel("senado")).toBe("Senado");
    expect(chamberLabel("bundestag")).toBe("Bundestag (Germany)");
  });
});
