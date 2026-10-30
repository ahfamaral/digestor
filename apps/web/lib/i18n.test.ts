import { describe, expect, it } from "vitest";
import { HIGHLIGHT_TYPES, PROFILES } from "@digestor/core";
import { en } from "@/messages/en";
import { localeFromHeaders, t, type MessageKey } from "./i18n";

describe("i18n", () => {
  it("t interpolates and throws on a missing var", () => {
    expect(t("upload.uploadingBadge", { pct: 42 })).toBe("Uploading 42%");
    expect(t("upload.title")).toBe("Digest a long video");
    expect(() => t("upload.uploadingBadge")).toThrow(/pct/);
    expect(() => t("upload.uploadingBadge", { other: 1 })).toThrow(/pct/);
  });

  it("every PROFILES and HIGHLIGHT_TYPES id has a message key", () => {
    for (const [id, p] of Object.entries(PROFILES)) expect(t(`profile.${id}` as MessageKey)).toBe(p.label);
    for (const [id, h] of Object.entries(HIGHLIGHT_TYPES)) expect(t(`highlight.${id}` as MessageKey)).toBe(h.label);
    expect(en.profile.parliament).toBe("Parliament");
  });

  it("localeFromHeaders picks the first language", () => {
    expect(localeFromHeaders(new Headers({ "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" }))).toBe("pt-BR");
    expect(localeFromHeaders(new Headers({ "accept-language": "fr;q=0.7" }))).toBe("fr");
    expect(localeFromHeaders(new Headers())).toBe("en");
    expect(localeFromHeaders(new Headers({ "accept-language": "*" }))).toBe("en");
  });
});
