import Link from "next/link";
import { VOTE_FILTERS } from "@digestor/core";
import { formatCount, formatMonth, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, keptBy, MAX_QUERY, VOTE_VALUES, type DeputyParams } from "@/lib/monitor/params";
import type { RecordMeaning, Searched } from "@/lib/monitor/search";
import { ExactBox } from "./ExactBox";
import { FormSelect } from "./FormSelect";
import { GetForm } from "./GetForm";
import { KeptFields } from "./KeptFields";
import { MeaningCount, MeaningNote } from "./MeaningNote";
import { SearchedFor } from "./SearchedFor";

const VOTES = "votes";
const box = "size-4 shrink-0 rounded border-input accent-brand outline-none focus-visible:ring-2 focus-visible:ring-stone-500";
const link = "rounded px-1 font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500";

/** The months of `year` up to today's (all twelve for a past year), "YYYY-MM". */
export function monthsOf(year: number, today: string): string[] {
  const last = Number(today.slice(0, 4)) === year ? Number(today.slice(5, 7)) : 12;
  return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/** Any of the vote filters set. */
export const votesFiltered = (p: DeputyParams) => !!(p.vq || p.vv || p.vk || p.vfrom || p.vto || p.vdiff);

/** The votes a guidance can be compared with, within the other filters and overall (`listMemberVotes`); unknown = undefined. */
export type Guided = { guided?: number; guidedAll?: number };

/**
 * The empty state of a filtered vote list, saying why: no guidance published for this deputy's party at all, none for
 * the votes the other filters keep, or none of the comparable votes differs. Never "0 differ" when the guidance is unknown.
 */
export function votesEmpty(locale: MonitorLocale, p: DeputyParams, g: Guided): string {
  if (p.vdiff && g.guidedAll === 0) return tm(locale, "voteFilters.noGuidance");
  if (p.vdiff && g.guided === 0) return tm(locale, "votes.noneGuided");
  if (p.vdiff && g.guided !== undefined) {
    return g.guided === 1 ? tm(locale, "votes.noneDifferOne") : tm(locale, "votes.noneDiffer", { n: formatCount(g.guided, locale) });
  }
  return tm(locale, "votes.none");
}

/**
 * The deputy page's filter row for their recorded votes (a GET form, works without JavaScript): words in what was
 * voted, the vote as published, a bill or a request, months, and "Different from the party's guidance". Then, when a
 * filter is set, "N of M recorded votes" (this deputy's own records only) and a way to clear them.
 */
export function VoteFilters({
  locale, externalId, params, today, total, all, searched, guidedAll, meaning, meaningOnly = 0, meaningHidden = 0,
}: {
  locale: MonitorLocale; externalId: number; params: DeputyParams; today: string; total: number; all: number; searched: Searched | null;
  /** Votes a guidance can be compared with, overall; 0: the guidance checkbox is replaced by a line saying why. */
  guidedAll?: number;
  /** How the text box was searched; `meaningOnly`: the rows only the search by meaning found (part of `total`, never counted as matches). */
  meaning?: RecordMeaning; meaningOnly?: number;
  /** No word match: the rows the search by meaning found, held back until asked for (`vmeaning`). */
  meaningHidden?: number;
}) {
  const months = monthsOf(params.year, today).map((m) => ({ value: m, label: formatMonth(m, locale) }));
  const filtered = votesFiltered(params);
  return (
    <div className="grid gap-2">
      <GetForm label={tm(locale, "forms.votes")} action={`${deputyHref(externalId)}#${VOTES}`} className="grid gap-3 rounded-xl border border-border bg-white p-3 sm:p-4">
        <div className="flex gap-2">
          <label htmlFor="votes-q" className="sr-only">{tm(locale, "voteFilters.label")}</label>
          <input
            id="votes-q"
            name="vq"
            type="search"
            defaultValue={params.vq}
            maxLength={MAX_QUERY}
            placeholder={tm(locale, "voteFilters.placeholder")}
            className="h-9 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500 md:text-sm"
          />
          <button
            type="submit"
            className="inline-flex h-9 shrink-0 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-stone-500"
          >
            {tm(locale, "voteFilters.apply")}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FormSelect
            name="vv" label={tm(locale, "voteFilters.vote")} anyLabel={tm(locale, "filters.any")} lang="pt-BR" value={params.vv}
            options={VOTE_VALUES.map((v) => ({ value: v, label: VOTE_FILTERS[v] }))}
          />
          <FormSelect
            name="vk" label={tm(locale, "voteFilters.kind")} anyLabel={tm(locale, "filters.any")} value={params.vk}
            options={[{ value: "bill", label: tm(locale, "voteFilters.kindBill") }, { value: "request", label: tm(locale, "voteFilters.kindRequest") }]}
          />
          <FormSelect name="vfrom" label={tm(locale, "filters.from")} anyLabel={tm(locale, "filters.any")} options={months} value={params.vfrom} />
          <FormSelect name="vto" label={tm(locale, "filters.to")} anyLabel={tm(locale, "filters.any")} options={months} value={params.vto} />
        </div>
        {guidedAll === 0 ? (
          <p className="text-xs text-muted-foreground">{tm(locale, "voteFilters.noGuidance")}</p>
        ) : (
          <div className="grid gap-1">
            <label className="flex w-fit items-center gap-1.5 text-sm">
              <input type="checkbox" name="vdiff" value="1" defaultChecked={params.vdiff} aria-describedby="votes-differs-note" className={box} />
              {tm(locale, "voteFilters.differs")}
            </label>
            <p id="votes-differs-note" className="text-xs text-muted-foreground">
              {tm(locale, "voteFilters.differsNote")}
              {guidedAll !== undefined && guidedAll < all && (
                <> {tm(locale, "voteFilters.guidedCount", { n: formatCount(guidedAll, locale), total: formatCount(all, locale) })}.</>
              )}
            </p>
          </div>
        )}
        <ExactBox locale={locale} checked={params.vexact} name="vexact" />
        <KeptFields params={keptBy("votes", params)} />
      </GetForm>
      {searched && <SearchedFor locale={locale} searched={searched} />}
      {filtered && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-sm">
          <p className="text-muted-foreground">
            {tm(locale, "votes.count", { n: formatCount(total - meaningOnly, locale), total: formatCount(all, locale) })}
            <MeaningCount locale={locale} n={meaningOnly} />
          </p>
          <Link href={`${deputyHref(externalId, keptBy("votes", params))}#${VOTES}`} className={link}>
            {tm(locale, "filters.clear")}
          </Link>
        </div>
      )}
      <MeaningNote locale={locale} section="votes" meaning={meaning} words={total - meaningOnly} meaningOnly={meaningOnly} hidden={meaningHidden} />
    </div>
  );
}
