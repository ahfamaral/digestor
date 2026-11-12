import { describe, expect, it } from "vitest";
import { misfiledCopies, normName, speechHeader, splitHighlights } from "./monitorText.ts";

describe("monitorText", () => {
  it("normName lower-cases, strips accents and collapses spaces", () => {
    expect(normName("  Fernanda   MELCHIONNA ")).toBe("fernanda melchionna");
    expect(normName("Máximo")).toBe("maximo");
  });

  it("splitHighlights splits on the ts_headline markers", () => {
    expect(splitHighlights("a \u0001b\u0002 c")).toEqual([
      { text: "a ", hit: false }, { text: "b", hit: true }, { text: " c", hit: false },
    ]);
    expect(splitHighlights("")).toEqual([]);
    expect(splitHighlights("\u0001x\u0002")).toEqual([{ text: "x", hit: true }]);
  });

  it("speechHeader reads the printed speaker, party and state", () => {
    expect(speechHeader("O SR. MAURICIO MARCON (PL - RS. Pela ordem. Sem revisão do orador.) - Obrigado, Presidente.")).toEqual({
      name: "MAURICIO MARCON", party: "PL", uf: "RS",
    });
    expect(speechHeader("O SR. JULIO CESAR RIBEIRO (Bloco/REPUBLICANOS - DF. Para proferir parecer.) - Sr. Presidente")).toEqual({
      name: "JULIO CESAR RIBEIRO", party: "REPUBLICANOS", uf: "DF",
    });
    expect(speechHeader("A SRA. JANDIRA FEGHALI (PCdoB - RJ. Sem revisão da oradora.) - Presidente")).toEqual({
      name: "JANDIRA FEGHALI", party: "PCdoB", uf: "RJ",
    });
    expect(speechHeader("O SR. PRESIDENTE (Hugo Motta. REPUBLICANOS - PB) - Está aberta a sessão.")).toEqual({
      name: "PRESIDENTE", party: "REPUBLICANOS", uf: "PB",
    });
    expect(speechHeader("DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO ROBERTO DUARTE (SEM REGISTRO TAQUIGRÁFICO). Senhor")).toEqual({
      name: "ROBERTO DUARTE", party: null, uf: null,
    });
    expect(speechHeader("DISCURSO NA ÍNTEGRA ENCAMINHADO PELA SRA. DEPUTADA LAURA CARNEIRO (SEM REGISTRO TAQUIGRÁFICO).").name).toBe("LAURA CARNEIRO");
    expect(speechHeader("Sr. Presidente, sem cabeçalho")).toEqual({ name: null, party: null, uf: null });
  });

  it("misfiledCopies keeps the copy the header names, by party and state on the day, else by name", () => {
    const marcon = "O SR. MAURICIO MARCON (PL - RS. Sem revisão do orador.) - Presidente Charles";
    expect(misfiledCopies(marcon, [
      { id: 1, name: "Marcon", party: "PT", uf: "RS" },
      { id: 2, name: "Mauricio Marcon", party: "PL", uf: "RS" },
    ])).toEqual([1]);
    const bacelar = "O SR. JOÃO CARLOS BACELAR (PL - BA. Pela ordem.) - Sr. Presidente";
    expect(misfiledCopies(bacelar, [
      { id: 1, name: "Bacelar", party: "PV", uf: "BA" },
      { id: 2, name: "João Carlos", party: "REPUBLICANOS", uf: "AM" },
      { id: 3, name: "João Carlos Bacelar", party: "PL", uf: "BA" },
    ])).toEqual([1, 2]);
    const written = "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO ROBERTO DUARTE (SEM REGISTRO TAQUIGRÁFICO). Senhor";
    expect(misfiledCopies(written, [
      { id: 7, name: "Duarte Jr.", party: "PSB", uf: "MA" },
      { id: 8, name: "Roberto Duarte", party: "REPUBLICANOS", uf: "AC" },
    ])).toEqual([7]);
    // party unknown on the day (no history): the printed name decides
    expect(misfiledCopies(marcon, [
      { id: 1, name: "Marcon", party: null, uf: null },
      { id: 2, name: "Mauricio Marcon", party: null, uf: null },
    ])).toEqual([1]);
  });

  it("misfiledCopies keeps every copy when it can't tell", () => {
    expect(misfiledCopies("Sr. Presidente, sem cabeçalho", [
      { id: 1, name: "A", party: "PL", uf: "RS" },
      { id: 2, name: "B", party: "PT", uf: "RS" },
    ])).toEqual([]);
    // both copies match the header's party and state, and neither name is the printed one
    expect(misfiledCopies("O SR. FULANO (PL - RS.) - x", [
      { id: 1, name: "Fulano Silva", party: "PL", uf: "RS" },
      { id: 2, name: "Fulano Souza", party: "PL", uf: "RS" },
    ])).toEqual([]);
    expect(misfiledCopies("O SR. FULANO (PL - RS.) - x", [{ id: 1, name: "Fulano", party: "PT", uf: "SP" }])).toEqual([]);
  });
});
