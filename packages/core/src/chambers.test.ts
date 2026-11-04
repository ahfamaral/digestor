import { describe, expect, it } from "vitest";
import { CHAMBER_IDS, CHAMBERS, chamberLabel, chamberThresholds } from "./chambers.ts";

describe("chambers", () => {
  it("lists the five houses in display order", () => {
    expect(CHAMBER_IDS).toEqual(["camara", "senado", "bundestag", "us_house", "us_senate"]);
    expect(CHAMBERS.bundestag.publishWindowDays).toBe(21);
    expect(CHAMBERS.us_house.idSystem).toBe("bioguide");
  });
  it("uses Infinity as confirm threshold for a house that is not evaluated", () => {
    expect(chamberThresholds("bundestag").confirm).toBe(Infinity);
    expect(chamberThresholds("senado")).toEqual({ confirm: 0.6, propose: 0.35 });
  });
  it("labels houses", () => {
    expect(chamberLabel("us_house")).toBe("House (USA)");
    expect(chamberLabel("senado")).toBe("Senado");
    expect(chamberLabel("bundestag")).toBe("Bundestag (Germany)");
  });
});
