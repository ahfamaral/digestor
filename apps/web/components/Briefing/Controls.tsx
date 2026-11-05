"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { HIGHLIGHT_TYPES, type Granularity, type HighlightTypeId } from "@digestor/core";
import { TONE_CHIP } from "@/components/HighlightChip";
import { DEFAULT_FILTERS, toSearchParams, type BriefingFilters, type ShowFilter } from "@/lib/briefingFilters";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";
import { Dropdown } from "@/components/Dropdown";
import { Busy } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";

const LEVELS: Granularity[] = ["exchange", "passage", "punchline"];
const LEVEL_TEXT: Record<Granularity, MessageKey> = {
  exchange: "briefing.levelExchanges",
  passage: "briefing.levelPassages",
  punchline: "briefing.levelPunchlines",
};
/** The status filter's order on screen (Open stays the default). */
const SHOW_ORDER: ShowFilter[] = ["all", "open", "approved", "skipped"];
const SHOW_TEXT: Record<ShowFilter, MessageKey> = {
  open: "briefing.showOpen",
  all: "briefing.showAll",
  approved: "briefing.showApproved",
  skipped: "briefing.showSkipped",
};
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
 * The Briefing page's instant filters: the levels (Exchanges / Passages / Punchlines checkboxes with their counts; one
 * stays ticked), Focus on one person or voice, minimum relevance, highlight-type chips and the status. Every change
 * is applied on screen at once.
 */
export function Controls({
  filters,
  onChange,
  choices,
  types,
  levelCounts,
  shown,
  findMore,
}: {
  filters: BriefingFilters;
  onChange: (next: BriefingFilters) => void;
  /** How many moments the analysis has at each level. */
  levelCounts: Record<Granularity, number>;
  choices: FocusChoice[];
  types: HighlightTypeId[];
  /** How many moments the tree shows ("N shown"). */
  shown: number;
  /** The "Find more" action for the focused person (shown beside the picker, with its outcome below), or null when focus isn't on a person. */
  findMore: { label: string; busy: boolean; onClick: () => void; error: string | null; summary: string | null } | null;
}) {
  const set = (patch: Partial<BriefingFilters>) => onChange({ ...filters, ...patch });
  const focusValue = filters.person !== null ? `p:${filters.person}` : filters.speaker !== null ? `v:${filters.speaker}` : "";
  const toggleType = (type: HighlightTypeId) =>
    set({ types: filters.types.includes(type) ? filters.types.filter((x) => x !== type) : [...filters.types, type] });

  return (
    <>
    <section aria-label={t("briefing.filters")} className="mb-4 grid gap-3 rounded-xl border border-border bg-white p-3 sm:p-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="grid gap-1">
          <span id="levels-label" className={LABEL}>
            {t("briefing.levels")}
          </span>
          <div role="group" aria-labelledby="levels-label" className="flex flex-wrap gap-1.5">
            {LEVELS.map((g) => {
              const on = filters.levels.includes(g);
              const last = on && filters.levels.length === 1;
              return (
                <label
                  key={g}
                  title={last ? t("briefing.levelLast") : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md border border-border bg-white px-2.5 text-sm text-foreground",
                    last ? "cursor-not-allowed" : "cursor-pointer hover:bg-muted",
                  )}
                >
                  <Checkbox
                    checked={on}
                    disabled={last}
                    onCheckedChange={(v) => set({ levels: LEVELS.filter((l) => (l === g ? v === true : filters.levels.includes(l))) })}
                  />
                  {t(LEVEL_TEXT[g])}
                  <span className="font-mono text-[11px] text-muted-foreground">{levelCounts[g]}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="grid gap-1">
          <label htmlFor="focus-speaker" className={LABEL}>
            {t("briefing.focus")}
          </label>
          <div className="flex items-center gap-1">
            <span className="relative">
              <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Dropdown
                id="focus-speaker"
                value={focusValue}
                onValueChange={(v) => {
                  // Person and voice are exclusive: choosing one clears the other.
                  const [kind, ...rest] = v.split(":");
                  const id = rest.join(":");
                  set({ person: kind === "p" && id ? id : null, speaker: kind === "v" && id ? id : null });
                }}
                className="max-w-64 pl-7"
                options={[
                  { value: "", label: t("briefing.everyone") },
                  ...choices.map((c) => ({ value: choiceValue(c), label: focusText(c), title: shareTitle(c) })),
                ]}
              />
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
            {findMore && (
              <button
                type="button"
                disabled={findMore.busy}
                onClick={findMore.onClick}
                className="inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Busy busy={findMore.busy}>{findMore.label}</Busy>
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
          <Dropdown
            id="show-status"
            value={filters.show}
            onValueChange={(v) => set({ show: v })}
            options={SHOW_ORDER.map((s) => ({ value: s, label: t(SHOW_TEXT[s]) }))}
          />
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
    {findMore?.error && (
      <p role="alert" className="mb-2 text-xs text-red-700">
        {findMore.error}
      </p>
    )}
    {findMore?.summary && (
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        {findMore.summary}
      </p>
    )}
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span aria-live="off">{shown === 1 ? t("briefing.shownOne") : t("briefing.shownMany", { n: shown })}</span>
      {toSearchParams(filters) !== "" && (
        <button type="button" onClick={() => onChange(DEFAULT_FILTERS)} className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand">
          {t("briefing.reset")}
        </button>
      )}
    </div>
    </>
  );
}