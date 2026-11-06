"use client";

import { personAt, type Range } from "@digestor/core";
import { voiceConfirmBody, evidenceLine, badgeText, voiceLabel, type NamesData } from "@/lib/names";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { NamePopover } from "./NamePopover";

const BADGE_TONE: Record<string, string> = {
  human: "bg-violet-100 text-violet-800",
  record: "bg-green-100 text-green-800",
  caption: "bg-stone-200 text-stone-800",
  transcript: "bg-stone-200 text-stone-800",
  metadata: "bg-stone-200 text-stone-800",
};

/**
 * A voice's name with its source badge, and a dotted underline while the name is only proposed. "Speaker C" when
 * there is no name to show. Clicking it opens the name popover; hovering or focusing the badge gives the evidence.
 */
/** The ", " between two speakers in a list (every list of speakers uses it). */
export function SpeakerSep() {
  return (
    <span aria-hidden className="whitespace-pre">
      {", "}
    </span>
  );
}

export function SpeakerName({
  speakerId,
  atMs,
  names,
  sensitive,
  sessionId,
  range,
  ranges,
  language,
  className,
  rangeOnly,
  confirmBody,
}: {
  speakerId: string;
  atMs: number;
  names: NamesData;
  sensitive: boolean;
  sessionId: string;
  range?: Range;
  ranges?: Range[];
  language?: string;
  className?: string;
  rangeOnly?: boolean;
  confirmBody?: Record<string, unknown>;
}) {
  const label = voiceLabel(names, speakerId, atMs, sensitive);
  const res = personAt(names.attributions, speakerId, atMs);
  const evidence = label.badge !== null && res.kind === "named" ? evidenceLine(res.attribution) : null;
  const accessible = label.badge
    ? t("names.nameOf", { label: label.text, badge: badgeText(label.badge) })
    : t("names.popoverTitle", { label: label.text });
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <NamePopover
        sessionId={sessionId}
        speakerId={speakerId}
        label={label}
        names={names}
        range={range}
        ranges={ranges}
        rangeOnly={rangeOnly}
        atMs={atMs}
        confirmBody={confirmBody ?? voiceConfirmBody(names, speakerId, res, range) ?? undefined}
        trigger={
          <button
            type="button"
            aria-label={accessible}
            lang={label.badge ? language : undefined}
            dir="auto"
            className={cn(
              "rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand",
              label.proposed && "underline decoration-dotted underline-offset-2",
            )}
          >
            {label.text}
          </button>
        }
      />
      {label.badge && (
        <span
          tabIndex={0}
          title={evidence ?? undefined}
          className={cn(
            "cursor-help rounded-full px-1.5 py-px text-[10.5px] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand",
            BADGE_TONE[label.badge],
          )}
        >
          {badgeText(label.badge)}
          {evidence && <span className="sr-only">. {evidence}</span>}
        </span>
      )}
    </span>
  );
}
