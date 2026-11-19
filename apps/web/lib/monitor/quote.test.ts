import { describe, expect, it } from "vitest";
import { HIGHLIGHT_END as E, HIGHLIGHT_START as S } from "@digestor/core";
import { quoteWithSource, shownExcerpt } from "./quote";

const base = {
  quote: "A saúde pública  precisa de mais recursos.", name: "Fernanda Melchionna", party: "PSOL", uf: "RS", startsAt: "2026-03-10T14:05",
  urlText: "https://www.camara.leg.br/internet/sitaqweb/TextoHTML.asp?nuSessao=1", video: null,
};

describe("quoteWithSource", () => {
  it("the quote in quotation marks, who (party-UF on the day) and when (Brasília time), the official record", () => {
    expect(quoteWithSource("en", base)).toBe([
      "“A saúde pública precisa de mais recursos.”",
      "Fernanda Melchionna (PSOL-RS), Mar 10, 2026, 2:05 PM, Brasília time",
      "Official record: https://www.camara.leg.br/internet/sitaqweb/TextoHTML.asp?nuSessao=1",
    ].join("\n"));
  });

  it("a matched video adds the YouTube link at the speech's start, to the second", () => {
    const text = quoteWithSource("pt-BR", { ...base, video: { videoId: "abcdefghijk", startS: 4722.6, endS: 4900 } });
    expect(text.split("\n")).toEqual([
      "“A saúde pública precisa de mais recursos.”",
      "Fernanda Melchionna (PSOL-RS), 10 de mar. de 2026, 14:05, horário de Brasília",
      "Registro oficial: https://www.camara.leg.br/internet/sitaqweb/TextoHTML.asp?nuSessao=1",
      "Vídeo: https://www.youtube.com/watch?v=abcdefghijk&t=4722s",
    ]);
  });

  it("the Câmara's summary is labelled as theirs; no record link or party: those parts are left out", () => {
    const text = quoteWithSource("en", { ...base, quote: "Defendeu mais recursos para a saúde.", summary: true, urlText: null, party: null, uf: null });
    expect(text).toBe("Câmara summary: “Defendeu mais recursos para a saúde.”\nFernanda Melchionna, Mar 10, 2026, 2:05 PM, Brasília time");
    // a video id that isn't YouTube's is never linked
    expect(quoteWithSource("en", { ...base, video: { videoId: "x", startS: 1, endS: 2 } })).not.toContain("Video:");
  });
});

describe("shownExcerpt", () => {
  it("unmarks the matched words, joins fragments with … and marks where the excerpt is cut", () => {
    const text = "Senhor Presidente, a saúde pública precisa de mais recursos e o governo não ouve";
    expect(shownExcerpt(`a ${S}saúde${E} pública precisa`, null, text)).toEqual({ quote: "… a saúde pública precisa …", summary: false });
    expect(shownExcerpt(`Senhor Presidente ... ${S}governo${E} não ouve`, null, text).quote).toBe("Senhor Presidente … governo não ouve");
  });

  it("an excerpt taken from the Câmara's summary says so (copied as the summary, not as the deputy's words)", () => {
    const summary = "Defesa de mais recursos para a saúde pública.";
    expect(shownExcerpt(summary, summary, "Senhor Presidente, a saúde pública precisa de mais recursos")).toEqual({ quote: summary, summary: true });
    expect(shownExcerpt("a saúde pública precisa", summary, "Senhor Presidente, a saúde pública precisa de mais recursos").summary).toBe(false);
  });
});
