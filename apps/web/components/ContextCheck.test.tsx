import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextCard } from "@digestor/core";
import { ContextCheck } from "./ContextCheck";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const none = { value: null, source: null, evidence: null };
function card(date: string | null): ContextCard {
  return {
    language: { value: "pt", source: "video", evidence: null },
    profile: { value: "parliament", confidence: 0.9, evidence: null },
    title: { value: "Sessão", source: "metadata", evidence: null },
    summary: "",
    setting: none,
    dateOrYear: date ? { value: date, source: "metadata", evidence: null } : none,
    participants: [],
    sufficient: true,
    openQuestions: [],
  };
}

const render = (c: ContextCard, recordDate: string | null) =>
  renderToStaticMarkup(
    <ContextCheck sessionId="00000000-0000-4000-8000-000000000001" card={c} names={{ persons: [], attributions: [] }} rows={[]} proxyReady={false} hasVideo recordDate={recordDate} />,
  );

describe("ContextCheck date from the official record", () => {
  it("fills an empty Date with the record's day and says where it came from", () => {
    const html = render(card(null), "2026-03-10");
    expect(html).toMatch(/aria-label="Date" placeholder="not found" value="2026-03-10"/);
    expect(html).toContain("from record");
    expect(html).toContain("From the official record");
  });

  it("never replaces a stored date, and says nothing without a record date", () => {
    const stored = render(card("2025"), "2026-03-10");
    expect(stored).toMatch(/aria-label="Date" placeholder="not found" value="2025"/);
    expect(stored).not.toContain("From the official record");
    const without = render(card(null), null);
    expect(without).toMatch(/aria-label="Date" placeholder="not found" value=""/);
    expect(without).not.toContain("From the official record");
  });
});
