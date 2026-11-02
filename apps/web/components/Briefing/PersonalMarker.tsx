import type { MomentOrigin } from "@digestor/core";
import { MethodBadge } from "@/components/HighlightChip";
import { t } from "@/lib/i18n";

/** The violet "Added by …" / "Found for you" marker of a personal moment; a found moment also carries the AI badge. */
export function PersonalMarker({ origin }: { origin: MomentOrigin }) {
  const text = origin === "ask" ? t("briefing.addedByAsk") : origin === "user" ? t("briefing.addedByYou") : origin === "find_more" ? t("briefing.foundForYou") : null;
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-100 px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-violet-800">
      {text}
      {origin === "find_more" && <MethodBadge method="ai" />}
    </span>
  );
}
