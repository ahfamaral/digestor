import { describe, expect, it } from "vitest";
import { snippetCuts } from "./snippet";

const text = "O SR. FULANO (PL - PB. Sem revisão do orador.) - Sr. Presidente, a segurança pública no Brasil precisa de recursos. Os estados não conseguem pagar a polícia e a violência cresce.";

describe("snippetCuts", () => {
  it("a fragment from the middle of a sentence gets both", () => {
    expect(snippetCuts("a \u0001segurança\u0002 pública no Brasil precisa", null, text)).toEqual({ before: true, after: true });
  });
  it("starting after the header or a sentence end, and ending the text, gets neither", () => {
    expect(snippetCuts("Sr. Presidente, a \u0001segurança\u0002 pública", null, text)).toEqual({ before: false, after: true });
    expect(snippetCuts("Os estados não conseguem pagar a polícia e a violência cresce.", null, text)).toEqual({ before: false, after: false });
  });
  it("a snippet ending a sentence mid-text gets no trailing mark", () => {
    expect(snippetCuts("pública no Brasil precisa de recursos.", null, text)).toEqual({ before: true, after: false });
  });
  it("two fragments: the first's start and the last's end decide", () => {
    expect(snippetCuts("a segurança pública ... pagar a polícia", null, text)).toEqual({ before: true, after: true });
  });
  it("the summary comes first, joined as the search joins it", () => {
    expect(snippetCuts("Defesa da \u0001segurança\u0002 pública.", "Defesa da segurança pública.", text)).toEqual({ before: false, after: false });
    expect(snippetCuts("Sr. Presidente, a segurança", "Defesa da segurança pública.", text)).toEqual({ before: false, after: true });
  });
  it("whitespace differences don't matter; an unplaced snippet gets neither", () => {
    expect(snippetCuts("segurança  pública\nno", null, text).before).toBe(true);
    expect(snippetCuts("nothing like it", null, text)).toEqual({ before: false, after: false });
    expect(snippetCuts("", null, text)).toEqual({ before: false, after: false });
  });
});
