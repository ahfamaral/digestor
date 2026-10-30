import { HIGHLIGHT_TYPES, type HighlightMethod, type HighlightTypeId, type Tone } from "@digestor/core";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Chip colours per highlight tone (literal class names so Tailwind sees them). Colour is reserved for highlight types. */
export const TONE_CHIP: Record<Tone, string> = {
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  amber: "bg-amber-100 text-amber-900",
  violet: "bg-violet-100 text-violet-800",
  green: "bg-green-100 text-green-800",
  teal: "bg-teal-100 text-teal-800",
  slate: "bg-slate-200 text-slate-800",
  pink: "bg-pink-100 text-pink-800",
};

/** Solid dot colours for timeline pins and the legend. */
export const TONE_DOT: Record<Tone, string> = {
  red: "bg-red-600",
  blue: "bg-blue-600",
  amber: "bg-amber-500",
  violet: "bg-violet-600",
  green: "bg-green-600",
  teal: "bg-teal-600",
  slate: "bg-slate-500",
  pink: "bg-pink-600",
};

/**
 * A highlight type chip: always text (the type's label, or its card heading with `card`), tinted with the type's
 * tone, plus how it was produced — "AI" for model judgments, "counted" for values computed from the transcript.
 */
export function HighlightChip({ type, method, card, className }: { type: HighlightTypeId; method: HighlightMethod; card?: boolean; className?: string }) {
  const config = HIGHLIGHT_TYPES[type];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap", TONE_CHIP[config.tone], className)}>
      {card ? t(`highlightCard.${type}`) : t(`highlight.${type}`)}
      <span className="rounded-full bg-white/70 px-1.5 text-[10px] leading-4 font-bold tracking-wide">
        {method === "counted" ? t("preview.badgeCounted") : t("preview.badgeAi")}
      </span>
    </span>
  );
}
