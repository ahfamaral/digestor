"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { HIGHLIGHT_TYPES, type Granularity, type HighlightTypeId } from "@digestor/core";
import { TONE_CHIP } from "@/components/HighlightChip";
import { SHOW_FILTERS, type BriefingFilters, type ShowFilter } from "@/lib/briefingFilters";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";

const LEVELS: Granularity[] = ["exchange", "passage", "punchline"];
const SHOW_TEXT: Record<ShowFilter, MessageKey> = {
  open: "briefing.showOpen",
  all: "briefing.showAll",
  approved: "briefing.showApproved",
  neutral: "briefing.showNeutral",
  rejected: "briefing.showRejected",
};
const FIELD =
  "h-8 rounded-md border border-border bg-white px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand";
const LABEL = "text-xs font-semibold text-muted-foreground";

/** One Focus choice: a person or a voice, with the text shown for it (name and badge text, or "Speaker C") and its share of the words. */
export interface FocusChoice {
  kind: "person" | "voice";
  /** A person id or a speaker id. */
  id: string;
  name: string;
  /** Whole percent of the spoken words. */
  share: number;
}

/** The option's value: person and voice ids can't clash. */
const choiceValue = (c: Pick<FocusChoice, "kind" | "id">) => `${c.kind === "person" ? "p" : "v"}:${c.id}`;

/** "73% of spoken words" for the option's tooltip. */
function shareTitle(c: FocusChoice): string {
  return c.share === 0 ? t("briefing.speakerShareSmallTitle") : t("briefing.speakerShareTitle", { share: c.share });
}

export function focusText(c: FocusChoice): string {
  return c.share === 0 ? t("briefing.speakerShareSmall", { name: c.name }) : t("briefing.speakerShare", { name: c.name, share: c.share });
}

/**
 * The Full briefing's instant filters: granularity (Exchange / Passage / Punchline), Focus on one person or voice, minimum
 * relevance, highlight-type chips and which statuses to show. Every change is applied on screen at once.
 */
export function Controls({
  filters,
  onChange,
  choices,
  types,
}: {
  filters: BriefingFilters;
  onChange: (next: BriefingFilters) => void;
  choices: FocusChoice[];
  types: HighlightTypeId[];
}) {
  const set = (patch: Partial<BriefingFilters>) => onChange({ ...filters, ...patch });
  const focusValue = filters.person !== null ? `p:${filters.person}` : filters.speaker !== null ? `v:${filters.speaker}` : "";
  const toggleType = (type: HighlightTypeId) =>
    set({ types: filters.types.includes(type) ? filters.types.filter((x) => x !== type) : [...filters.types, type] });

  return (
    <section aria-label={t("briefing.filters")} className="mb-4 grid gap-3 rounded-xl border border-border bg-white p-3 sm:p-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="grid gap-1">
          <span id="granularity-label" className={LABEL}>
            {t("briefing.granularity")}
          </span>
          <div role="group" aria-labelledby="granularity-label" className="inline-flex rounded-lg border border-border bg-background p-0.5">
            {LEVELS.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={filters.granularity === g}
                onClick={() => set({ granularity: g })}
                className={cn(
                  "h-7 rounded-md px-3 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  filters.granularity === g && "bg-foreground text-white",
                )}
              >
                {t(`granularity.${g}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-1">
          <label htmlFor="focus-speaker" className={LABEL}>
            {t("briefing.focus")}
          </label>
          <div className="flex items-center gap-1">
            <span className="relative">
              <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <select
                id="focus-speaker"
                value={focusValue}
                onChange={(e) => {
                  // Person and voice are exclusive: choosing one clears the other.
                  const [kind, ...rest] = e.target.value.split(":");
                  const id = rest.join(":");
                  set({ person: kind === "p" && id ? id : null, speaker: kind === "v" && id ? id : null });
                }}
                className={cn(FIELD, "max-w-64 pl-7")}
              >
                <option value="">{t("briefing.everyone")}</option>
                {choices.map((c) => (
                  <option key={choiceValue(c)} value={choiceValue(c)} title={shareTitle(c)}>
                    {focusText(c)}
                  </option>
                ))}
              </select>
            </span>
            {focusValue !== "" && (
              <button
                type="button"
                onClick={() => set({ speaker: null, person: null })}
                aria-label={t("briefing.clearFocus")}
                title={t("briefing.clearFocus")}
                className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-white text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
              >
                <XIcon aria-hidden className="size-4" />
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-1">
          <label htmlFor="min-relevance" className={LABEL}>
            {t("briefing.relevance")} <span className="font-mono text-foreground">{filters.minRelevance}</span>
          </label>
          <input
            id="min-relevance"
            type="range"
            min={0}
            max={100}
            step={5}
            value={filters.minRelevance}
            aria-valuetext={t("briefing.relevanceValue", { n: filters.minRelevance })}
            onChange={(e) => set({ minRelevance: Number(e.target.value) })}
            className="h-8 w-40 accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
        </div>

        <div className="grid gap-1">
          <label htmlFor="show-status" className={LABEL}>
            {t("briefing.show")}
          </label>
          <select id="show-status" value={filters.show} onChange={(e) => set({ show: e.target.value as ShowFilter })} className={FIELD}>
            {SHOW_FILTERS.map((s) => (
              <option key={s} value={s}>
                {t(SHOW_TEXT[s])}
              </option>
            ))}
          </select>
        </div>
      </div>

      {types.length > 0 && (
        <div className="grid gap-1">
          <span id="types-label" className={LABEL}>
            {t("briefing.types")}
          </span>
          <div role="group" aria-labelledby="types-label" className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={filters.types.length === 0}
              onClick={() => set({ types: [] })}
              className={cn(
                "rounded-full border border-border bg-white px-2.5 py-0.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand",
                filters.types.length === 0 && "border-foreground bg-foreground text-white",
              )}
            >
              {t("briefing.allTypes")}
            </button>
            {types.map((type) => {
              const on = filters.types.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleType(type)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand",
                    on ? cn(TONE_CHIP[HIGHLIGHT_TYPES[type].tone], "border-current") : "border-border bg-white text-foreground",
                  )}
                >
                  {t(`highlight.${type}`)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
