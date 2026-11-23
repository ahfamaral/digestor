import type { Stage } from "@digestor/core";
import { t } from "@/lib/i18n";

/** A tab title: what the page is about, most specific first, then "Digestor" (WCAG 2.4.2). Empty parts are skipped. */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  return [...parts.filter((p): p is string => !!p?.trim()).map((p) => p.trim()), t("app.name")].join(" · ");
}

/** The screen `/s/[id]` shows for a stage, as the stepper names it. */
export function sessionScreenName(stage: Stage): string {
  if (stage === "ready") return t("appBar.step.Briefing");
  if (stage === "awaiting_context") return t("appBar.step.Context");
  return t("appBar.step.Processing");
}
