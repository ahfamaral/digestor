import { describe, expect, it } from "vitest";
import { applicableGuidance, differsFromGuidance, guidanceLabels, isRequestVote, linkBloc, VOTE_FILTERS, type StoredBloc } from "./monitorVotes.ts";

/** The parties at the vote in the dev data (2026), as the Câmara spells them. */
const PARTIES = [
  "PL", "PT", "UNIÃO", "PSD", "REPUBLICANOS", "PP", "MDB", "PODE", "PSB", "PSDB", "PDT", "PSOL", "PCdoB", "AVANTE", "NOVO", "PV",
  "SOLIDARIEDADE", "REDE", "PRD", "CIDADANIA", "MISSÃO", "DC",
];
/** The guidance labels published in 2026 (`parl_orientations.bloc`). */
const LABELS = [
  "Bl UniPpPsd...", "PSB", "Oposição", "PDT", "Fdr PSOL-REDE", "Maioria", "Minoria", "PL", "Novo", "Governo", "Fdr PT-PCdoB-PV", "Missão",
  "Bl AvanSolidPrd...", "PRD", "Avante", "Solidaried", "DC",
];
const of = (party: string) => guidanceLabels(party, LABELS, PARTIES);

describe("guidanceLabels", () => {
  it("a party's own label first, accents and case aside", () => {
    expect(of("PL")).toEqual([{ label: "PL", rank: 0 }]);
    expect(of("NOVO")).toEqual([{ label: "Novo", rank: 0 }]);
    expect(of("MISSÃO")).toEqual([{ label: "Missão", rank: 0 }]);
  });

  it("a label cut short names its party when no other party starts the same way", () => {
    expect(of("SOLIDARIEDADE")).toEqual([{ label: "Solidaried", rank: 0 }, { label: "Bl AvanSolidPrd...", rank: 2 }]);
  });

  it("a federation speaks for each of its parties", () => {
    for (const p of ["PT", "PCdoB", "PV"]) expect(of(p)).toEqual([{ label: "Fdr PT-PCdoB-PV", rank: 1 }]);
    expect(of("PSOL")).toEqual([{ label: "Fdr PSOL-REDE", rank: 1 }]);
  });

  it("a bloc speaks for the parties its published name shows", () => {
    expect(of("UNIÃO")).toEqual([{ label: "Bl UniPpPsd...", rank: 2 }]);
    expect(of("PP")).toEqual([{ label: "Bl UniPpPsd...", rank: 2 }]);
    expect(of("PSD")).toEqual([{ label: "Bl UniPpPsd...", rank: 2 }]);
    // "Psd" is PSD itself, never the start of PSDB
    expect(of("PSDB")).toEqual([]);
    expect(of("AVANTE")).toEqual([{ label: "Avante", rank: 0 }, { label: "Bl AvanSolidPrd...", rank: 2 }]);
    expect(of("PRD")).toEqual([{ label: "PRD", rank: 0 }, { label: "Bl AvanSolidPrd...", rank: 2 }]);
  });

  it("a party the published names don't show has no guidance (the names after '...' are unknown)", () => {
    for (const p of ["MDB", "REPUBLICANOS", "PODE", "CIDADANIA", "", "XYZ"]) expect(of(p)).toEqual([]);
  });

  it("government, majority, opposition and minority are never a party's guidance", () => {
    const all = PARTIES.flatMap((p) => of(p).map((x) => x.label));
    for (const l of ["Governo", "Maioria", "Oposição", "Minoria"]) expect(all).not.toContain(l);
    expect(guidanceLabels("GOVERNO", ["Governo"], ["GOVERNO"])).toEqual([]);
  });

  it("a label that could be two parties is no one's", () => {
    expect(guidanceLabels("PSDB", ["Ps"], ["PSDB", "PSOL"])).toEqual([]);
    expect(guidanceLabels("PSDB", ["Bl Ps..."], ["PSDB", "PSOL"])).toEqual([]);
  });
});

/** As the Câmara API lists them on 2026-11-13 (`/blocos?idLegislatura=57`, `/blocos/{id}/partidos`). */
const BIG = "UNIÃO, PP, PSD, REPUBLICANOS, MDB, Federação PSDB CIDADANIA, PODE";
const BLOCS: StoredBloc[] = [
  { name: "AVANTE, SOLIDARIEDADE, PRD", federation: false, parties: [] },
  { name: "Federação Brasil da Esperança - Fe Brasil", federation: true, parties: ["PT", "PCdoB", "PV"] },
  { name: "Federação PSDB CIDADANIA", federation: true, parties: ["PSDB", "CIDADANIA"] },
  { name: "Federação PSOL REDE", federation: true, parties: ["PSOL", "REDE"] },
  { name: "REPUBLICANOS", federation: false, parties: [] },
  { name: "UNIÃO", federation: false, parties: [] },
  { name: BIG, federation: false, parties: ["PSDB", "CIDADANIA", "UNIÃO", "PP", "REPUBLICANOS", "PSD", "MDB", "PODE"] },
];

describe("linkBloc", () => {
  it("links a cut-short label to the one stored bloc whose listed parties start that way, in order", () => {
    expect(linkBloc("Bl UniPpPsd...", BLOCS, PARTIES)?.name).toBe(BIG);
    expect(linkBloc("Bl AvanSolidPrd...", BLOCS, PARTIES)?.name).toBe("AVANTE, SOLIDARIEDADE, PRD");
    // not in order, a federation, or two blocs that fit: none
    expect(linkBloc("Bl PpUni...", BLOCS, PARTIES)).toBeNull();
    expect(linkBloc("Bl PsdbCid...", BLOCS, PARTIES)).toBeNull();
    expect(linkBloc("Bl Uni...", [...BLOCS, { name: "UNIÃO, PL", federation: false, parties: ["UNIÃO", "PL"] }], PARTIES)).toBeNull();
    expect(linkBloc("PL", BLOCS, PARTIES)).toBeNull();
  });
});

describe("applicableGuidance", () => {
  const of2 = (party: string) => applicableGuidance(party, LABELS, PARTIES, BLOCS);
  it("a bloc's published members get its guidance, with the bloc's full name as the source", () => {
    for (const party of ["MDB", "REPUBLICANOS", "PODE", "PSDB", "CIDADANIA"]) {
      expect(of2(party)).toEqual([{ label: "Bl UniPpPsd...", rank: 2, source: BIG }]);
    }
    expect(of2("PSD")).toEqual([{ label: "Bl UniPpPsd...", rank: 2, source: BIG }]);
  });

  it("own label and federation as before (own: no source; federation: its label); stored members only for blocs", () => {
    expect(of2("PL")).toEqual([{ label: "PL", rank: 0, source: null }]);
    expect(of2("PT")).toEqual([{ label: "Fdr PT-PCdoB-PV", rank: 1, source: "Fdr PT-PCdoB-PV" }]);
  });

  it("a linked bloc listed with no members (dissolved): the name rule, with the label as the source", () => {
    expect(of2("AVANTE")).toEqual([
      { label: "Avante", rank: 0, source: null },
      { label: "Bl AvanSolidPrd...", rank: 2, source: "Bl AvanSolidPrd..." },
    ]);
  });

  it("no stored blocs: exactly the name rule", () => {
    expect(applicableGuidance("MDB", LABELS, PARTIES, [])).toEqual([]);
    expect(applicableGuidance("PSD", LABELS, PARTIES, [])).toEqual([{ label: "Bl UniPpPsd...", rank: 2, source: "Bl UniPpPsd..." }]);
  });
});

describe("isRequestVote and VOTE_FILTERS", () => {
  it("marks a request by its bill or its description", () => {
    expect(isRequestVote("Aprovado.", "REQ 4063/2026")).toBe(true);
    expect(isRequestVote("Rejeitado o Requerimento.", "MPV 1313/2025")).toBe(true);
    expect(isRequestVote("Requerimento de urgência", null)).toBe(true);
    expect(isRequestVote("Aprovada a Subemenda Substitutiva.", "PL 1/2026")).toBe(false);
  });

  it("vote filters map to the labels as published", () => {
    expect(VOTE_FILTERS).toEqual({ sim: "Sim", nao: "Não", abstencao: "Abstenção", obstrucao: "Obstrução" });
  });
});

describe("differsFromGuidance", () => {
  it("is the vdiff rule: a directed guidance the vote differs from", () => {
    expect(differsFromGuidance("Não", "Sim")).toBe(true);
    expect(differsFromGuidance("Abstenção", "Não")).toBe(true);
    expect(differsFromGuidance("Sim", "Obstrução")).toBe(true);
    expect(differsFromGuidance("Sim", "Sim")).toBe(false);
  });
  it("a free vote, no guidance or the chair's Artigo 17 never counts", () => {
    expect(differsFromGuidance("Não", "Liberado")).toBe(false);
    expect(differsFromGuidance("Não", null)).toBe(false);
    expect(differsFromGuidance("Não", "")).toBe(false);
    expect(differsFromGuidance("Artigo 17", "Sim")).toBe(false);
  });
});
