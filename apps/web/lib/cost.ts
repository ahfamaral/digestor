// Cost labels for the journalist screens (client-safe): every rate and estimate lives in core `cost.ts`.

import { estimateTranslationUsd, usdAmount, type Spending } from "@digestor/core";
import { draftRange } from "@/lib/askText";
import { t } from "@/lib/i18n";

/** An estimate: "about $0.42", or "under $0.01" (never "about under …"). */
export function aboutUsd(usd: number): string {
  const a = usdAmount(usd);
  return a.under ? t("cost.under") : t("cost.about", { amount: a.amount });
}

/** A recorded figure: "$0.132" (three decimals under ten cents), or "under $0.01". */
export function recordedUsd(usd: number): string {
  const a = usdAmount(usd, { precise: true });
  return a.under ? t("cost.under") : t("cost.recorded", { amount: a.amount });
}

/**
 * A clip package's paid part: translating the subtitle drafts of the ticked clips (their edited lengths). Rendering runs
 * on this server; drafts in the video's own language make no model call. An unknown video language counts as translated.
 */
export function packageCostUsd(
  clips: { on: boolean; start: string; end: string }[],
  offered: { startMs: number; endMs: number }[],
  subtitles: string | null,
  videoLanguage: string | null | undefined,
): number {
  if (subtitles === null) return 0;
  const ms = clips.reduce((n, c, i) => {
    if (!c.on || !offered[i]) return n;
    const r = draftRange(c, offered[i]);
    return n + (r.endMs - r.startMs);
  }, 0);
  return estimateTranslationUsd(ms, subtitles !== videoLanguage);
}

/** The Briefing page's "Spending" lines: the estimate against what was recorded, then what each figure covers. */
export function spendingLines(s: Spending): { summary: string; detail: string } {
  const runs = s.meteredAnalyses + s.unmeteredAnalyses;
  const summary = t("cost.spendingSummary", {
    estimated: aboutUsd(s.estimatedUsd),
    recorded: s.meteredAnalyses > 0 ? recordedUsd(s.recordedUsd) : t("cost.spendingNoneRecorded"),
  });
  const unpriced = s.unpricedCalls > 0 ? t("cost.spendingUnpriced", { n: s.unpricedCalls }) : "";
  const detail = t("cost.spendingDetail", { metered: s.meteredAnalyses, total: runs, transcription: aboutUsd(s.transcriptionUsd) }) + unpriced;
  return { summary, detail };
}

/** The Sessions page's line: everything spent so far (recorded where stored, estimated elsewhere). */
export function spentSoFarText(total: { bestUsd: number; recordedUsd: number }): { total: string; detail: string } {
  return {
    total: t("cost.spentSoFar", { total: aboutUsd(total.bestUsd) }),
    detail: t("cost.spentSoFarDetail", { recorded: recordedUsd(total.recordedUsd) }),
  };
}
