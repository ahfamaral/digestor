import type { Fact } from "@digestor/core";

export type BadgeKind = "video" | "metadata" | "human" | "missing" | "ai";

/** Source badge for a field: edited → "from you" (or missing if cleared); empty → missing; else the fact's own source. */
export function factBadge(fact: Fact | null, value: string, original: string): BadgeKind {
  if (value.trim() !== original.trim()) return value.trim() ? "human" : "missing";
  if (!value.trim()) return "missing";
  return fact?.source ?? "human";
}

/** The profile carries no source: the AI picked it, so it is "suggested by AI" until the user changes it. */
export function profileBadge(value: string, original: string): BadgeKind {
  return value !== original ? "human" : "ai";
}
