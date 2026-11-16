import { describe, expect, it } from "vitest";
import { displayTitle, looksLikeFileName } from "./sessionTitle.ts";

describe("looksLikeFileName", () => {
  it("spots slugs and media file names", () => {
    expect(looksLikeFileName("globo-debate-lula-flavio")).toBe(true);
    expect(looksLikeFileName("sessao_plenaria_2026")).toBe(true);
    expect(looksLikeFileName("Debate final.mp4")).toBe(true);
    expect(looksLikeFileName("merkel-interview.MOV")).toBe(true);
    expect(looksLikeFileName("audiência-pública-03")).toBe(true);
  });
  it("leaves real titles alone", () => {
    expect(looksLikeFileName("Debate na TV Globo entre Lula e Flávio Bolsonaro")).toBe(false);
    expect(looksLikeFileName("Demo interview (seeded)")).toBe(false);
    expect(looksLikeFileName("Merkel")).toBe(false);
    expect(looksLikeFileName("COP-30")).toBe(false);
    expect(looksLikeFileName("")).toBe(false);
  });
});

describe("displayTitle", () => {
  it("shows the context title in place of a file name", () => {
    expect(displayTitle("globo-debate-lula-flavio", "Debate na TV Globo entre Lula e Flávio Bolsonaro")).toBe("Debate na TV Globo entre Lula e Flávio Bolsonaro");
  });
  it("keeps the stored title when it is a real one or there is no context title", () => {
    expect(displayTitle("Merkel interview", "Interview with Angela Merkel")).toBe("Merkel interview");
    expect(displayTitle("globo-debate-lula-flavio", null)).toBe("globo-debate-lula-flavio");
    expect(displayTitle("globo-debate-lula-flavio", "  ")).toBe("globo-debate-lula-flavio");
  });
});
