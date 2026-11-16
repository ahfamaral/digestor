import { describe, expect, it } from "vitest";
import { byLetter, directoryOptions, filterDirectory, initials, letterOf, type DirectoryMember } from "./directory";

const dep = (externalId: number, name: string, party: string | null, uf: string | null, inOffice = true): DirectoryMember => ({
  externalId, name, party, uf, photoUrl: null, inOffice,
});
const members = [
  dep(1, "Ana Paula", "PT", "SP"), dep(2, "Átila Lira", "PP", "PI"), dep(3, "Bia Kicis", "PL", "DF"),
  dep(4, "Bruno Ganem", "NOVO", "SP", false), dep(5, "Érika Kokay", "PT", "DF"),
];
const none = { party: null, uf: null, former: false };

describe("directory", () => {
  it("in office only unless former; party and state narrow it, order kept", () => {
    expect(filterDirectory(members, none).map((m) => m.externalId)).toEqual([1, 2, 3, 5]);
    expect(filterDirectory(members, { ...none, former: true })).toHaveLength(5);
    expect(filterDirectory(members, { ...none, party: "PT" }).map((m) => m.externalId)).toEqual([1, 5]);
    expect(filterDirectory(members, { party: "PT", uf: "DF", former: false }).map((m) => m.externalId)).toEqual([5]);
    expect(filterDirectory(members, { ...none, party: "NOVO" })).toEqual([]);
  });

  it("options come from the deputies shown, plus the chosen value", () => {
    expect(directoryOptions(members, none)).toEqual({ parties: ["PL", "PP", "PT"], ufs: ["DF", "PI", "SP"] });
    expect(directoryOptions(members, { ...none, former: true }).parties).toEqual(["NOVO", "PL", "PP", "PT"]);
    expect(directoryOptions(members, { ...none, party: "NOVO" }).parties).toEqual(["NOVO", "PL", "PP", "PT"]);
  });

  it("letters ignore accents and case; anything else is #", () => {
    expect(letterOf("Átila")).toBe("A");
    expect(letterOf("érika")).toBe("E");
    expect(letterOf("Ç")).toBe("C");
    expect(letterOf("1º Tenente")).toBe("#");
    expect(letterOf("")).toBe("#");
  });

  it("groups by first letter in order, one group per letter", () => {
    const g = byLetter([...members, dep(6, "Ana Pimentel", "PT", "MG")]);
    expect(g.map((x) => x.letter)).toEqual(["A", "B", "E"]);
    expect(g[0]!.members.map((m) => m.externalId)).toEqual([1, 2, 6]);
  });
});

describe("initials", () => {
  it("first and last name's first letters, particles skipped", () => {
    expect(initials("Acácio Favacho")).toBe("AF");
    expect(initials("Adriano do Baldy")).toBe("AB");
    expect(initials("Érika Kokay")).toBe("ÉK");
    expect(initials("Tiririca")).toBe("T");
    expect(initials("  ")).toBe("");
    expect(initials("Pr. Marco Feliciano")).toBe("PF");
  });
});
