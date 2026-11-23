import Link from "next/link";
import type { MemberBill } from "@digestor/core/server";
import { formatCount, formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, keptBy, MAX_QUERY, type DeputyParams } from "@/lib/monitor/params";
import { billRowLabel, billTypeName } from "@/lib/monitor/billTypes";
import { billUrl, type RecordMeaning, type Searched } from "@/lib/monitor/search";
import { cn } from "@/lib/utils";
import { ExactBox } from "./ExactBox";
import { ExternalLink } from "./ExternalLink";
import { FormSelect } from "./FormSelect";
import { GetForm } from "./GetForm";
import { KeptFields } from "./KeptFields";
import { ByMeaning, MeaningCount, MeaningHeld, MeaningNote } from "./MeaningNote";
import { SearchedFor } from "./SearchedFor";
import { Pager } from "./Pager";
import { Section } from "./Section";

export const BILL_PAGE = 20;
/** Type filters and page links land on the list's heading instead of the top of the page. */
const BILLS = "bills";

/** A type code with its official name on hover (the "What the codes mean" list says it for touch and screen readers). */
const Code = ({ code }: { code: string }) => {
  const name = billTypeName(code);
  return name ? <abbr title={name} className="no-underline">{code}</abbr> : <>{code}</>;
};

const link = "rounded px-1 font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500";

/**
 * Bills and requests the deputy signed in the year: a filter row (words in the summary, the year presented when there
 * is more than one), counts by type (each a filter), what the type codes mean, the list, co-authorship marked. With a
 * filter set, "N of M bills and requests" (this deputy's own records only).
 */
export function AuthoredBills({
  locale, externalId, params, bills,
}: {
  locale: MonitorLocale; externalId: number; params: DeputyParams;
  bills: {
    total: number; all?: number; years?: number[]; byType: { type: string; n: number }[]; rows: (MemberBill & { byMeaning?: boolean })[];
    searched?: Searched | null; meaning?: RecordMeaning; meaningOnly?: number;
    /** No word match: the closest by meaning, held back until asked for (`bmeaning`). */
    meaningHidden?: number;
  };
}) {
  const all = bills.byType.reduce((s, r) => s + r.n, 0);
  const signed = bills.all ?? all;
  const years = bills.years ?? [];
  const filtered = !!(params.bq || params.byear || params.btype);
  const meaningOnly = bills.meaningOnly ?? 0;
  const form = signed > 0 && (
    <div className="grid gap-2">
      <GetForm label={tm(locale, "forms.bills")} action={`${deputyHref(externalId)}#${BILLS}`} className="grid gap-3 rounded-xl border border-border bg-white p-3 sm:p-4">
        <div className="flex gap-2">
          <label htmlFor="bills-q" className="sr-only">{tm(locale, "billFilters.label")}</label>
          <input
            id="bills-q"
            name="bq"
            type="search"
            defaultValue={params.bq}
            maxLength={MAX_QUERY}
            placeholder={tm(locale, "billFilters.placeholder")}
            className="h-9 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500 md:text-sm"
          />
          <button
            type="submit"
            className="inline-flex h-9 shrink-0 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-stone-500"
          >
            {tm(locale, "billFilters.apply")}
          </button>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <ExactBox locale={locale} checked={params.bexact} name="bexact" />
          {years.length > 1 && (
            <FormSelect
              name="byear" label={tm(locale, "billFilters.year")} anyLabel={tm(locale, "filters.any")} className="w-40"
              options={years.map(String)} value={params.byear ? String(params.byear) : null}
            />
          )}
        </div>
        <KeptFields params={keptBy("bills", params)} />
      </GetForm>
      {bills.searched && <SearchedFor locale={locale} searched={bills.searched} />}
      {filtered && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-sm">
          <p className="text-muted-foreground">
            {tm(locale, "bills.count", { n: formatCount(bills.total - meaningOnly, locale), total: formatCount(signed, locale) })}
            <MeaningCount locale={locale} n={meaningOnly} />
          </p>
          <Link href={`${deputyHref(externalId, { ...keptBy("bills", params), btype: null })}#${BILLS}`} className={link}>
            {tm(locale, "filters.clear")}
          </Link>
        </div>
      )}
      <MeaningNote locale={locale} section="bills" meaning={bills.meaning} words={bills.total - meaningOnly} meaningOnly={meaningOnly} hidden={bills.meaningHidden} />
    </div>
  );
  const filter = (type: string | null, text: React.ReactNode) => (
    <Link
      key={type ?? "all"}
      href={`${deputyHref(externalId, { ...params, btype: type, bp: 0 })}#${BILLS}`}
      aria-current={params.btype === type ? "true" : undefined}
      className={cn(
        "inline-block rounded px-1 py-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500",
        params.btype === type ? "font-semibold" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {text}
    </Link>
  );
  const types = bills.byType.length > 1 && (
    <nav aria-label={tm(locale, "bills.types")} className="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-xs">
          {filter(null, `${tm(locale, "bills.all")} (${formatCount(all, locale)})`)}
          {bills.byType.map((t) => (
            <span key={t.type} className="flex items-center gap-1">
              <span aria-hidden className="text-muted-foreground">·</span>
              {filter(t.type, <><Code code={t.type} /> ({formatCount(t.n, locale)})</>)}
            </span>
          ))}
        </nav>
  );
  const named = bills.byType.filter((t) => billTypeName(t.type));
  const codes = named.length > 0 && (
    <details className="text-xs">
      <summary className="w-fit cursor-pointer rounded text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
        {tm(locale, "bills.codes")}
      </summary>
      <dl lang="pt-BR" className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {named.map((t) => (
          <div key={t.type} className="contents">
            <dt className="font-mono">{t.type}</dt>
            <dd className="text-muted-foreground">{billTypeName(t.type)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
  return (
    <div className="grid gap-2">
      <div className="grid">
        <Section
          id={BILLS}
          title={tm(locale, "bills.title")}
          count={signed ? formatCount(signed, locale) : undefined}
          empty={
            bills.total
              ? null
              : bills.meaningHidden
                ? <MeaningHeld locale={locale} section="bills" hidden={bills.meaningHidden} showHref={`${deputyHref(externalId, { ...params, bmeaning: true, bp: 0 })}#${BILLS}`} />
                : signed > 0 && filtered ? tm(locale, "bills.none") : tm(locale, "bills.empty", { year: params.year })
          }
          toolbar={(form || types || codes) && <>{form}{types}{codes}</>}
        >
          {bills.rows.map((b) => (
            <li key={b.id} className="grid gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <ExternalLink href={billUrl(b.id)} className="font-semibold">{billRowLabel(locale, b)}</ExternalLink>
                <time dateTime={b.presentedAt} className="font-mono text-xs text-muted-foreground">{formatDay(b.presentedAt.slice(0, 10), locale)}</time>
                {!b.firstAuthor && <span className="text-xs text-muted-foreground">{tm(locale, "bills.coAuthor")}</span>}
                {b.byMeaning && <ByMeaning locale={locale} />}
              </div>
              {b.summary ? <p lang="pt-BR" className="break-words">{b.summary}</p> : <p className="text-muted-foreground">{tm(locale, "bills.noSummary")}</p>}
            </li>
          ))}
        </Section>
        <Pager locale={locale} page={params.bp} size={BILL_PAGE} total={bills.total} href={(bp) => `${deputyHref(externalId, { ...params, bp })}#${BILLS}`} label={tm(locale, "paging.bills")} />
      </div>
    </div>
  );
}
