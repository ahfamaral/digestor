import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDeputy } from "@/lib/monitor/params";
import { AuthoredBills } from "./AuthoredBills";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/monitor",
  useSearchParams: () => new URLSearchParams(),
}));

describe("AuthoredBills: items attached to a main bill", () => {
  const bills = {
    total: 2, byType: [{ type: "PRL", n: 1 }, { type: "SBR", n: 1 }],
    rows: [
      { id: 2651398, type: "PRL", number: 1, year: 0, summary: "Parecer da Relatora", presentedAt: "2026-11-09T10:53", firstAuthor: true, mainBillLabel: "PL 1761/2025" },
      { id: 2651653, type: "SBR", number: 2, year: 0, summary: "", presentedAt: "2026-11-09T14:47", firstAuthor: true, mainBillLabel: null },
    ],
  };
  it("labels them with their main bill, never shows /0, and says when no summary was published", () => {
    const en = renderToStaticMarkup(<AuthoredBills locale="en" externalId={204407} params={parseDeputy({})} bills={bills} />);
    expect(en).toContain("PRL 1 on PL 1761/2025");
    expect(en).toContain("SBR 2");
    expect(en).not.toContain("/0");
    expect(en).toContain("No summary published.");
    const pt = renderToStaticMarkup(<AuthoredBills locale="pt-BR" externalId={204407} params={parseDeputy({})} bills={bills} />);
    expect(pt).toContain("PRL 1 sobre o PL 1761/2025");
    expect(pt).toContain("Nenhum resumo publicado.");
  });
});
