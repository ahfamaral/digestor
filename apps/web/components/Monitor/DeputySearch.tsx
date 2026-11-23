import { Search } from "lucide-react";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, keptBy, MAX_QUERY, type DeputyParams } from "@/lib/monitor/params";
import { ExactBox } from "./ExactBox";
import { FormSelect } from "./FormSelect";
import { Spinner } from "@/components/ui/spinner";
import { GetForm } from "./GetForm";
import { KeptFields } from "./KeptFields";

const field = "h-9 w-full min-w-0 rounded-lg border border-input bg-white px-2 text-sm outline-none focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500";

/**
 * The deputy page's speech search (a GET form, works without JavaScript): this deputy's own speeches, or other
 * deputies' speeches mentioning them (the topic is optional then); dates and session phase.
 */
export function DeputySearch({ locale, externalId, params, phases }: { locale: MonitorLocale; externalId: number; params: DeputyParams; phases: string[] }) {
  const min = `${params.year}-01-01`;
  const max = `${params.year}-12-31`;
  return (
    <GetForm label={tm(locale, "forms.speeches")} action={`${deputyHref(externalId)}#speeches`} className="grid gap-3 rounded-xl border border-border bg-white p-4">
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <legend className="sr-only">{tm(locale, "deputySearch.rel")}</legend>
        {(["by", "mentions"] as const).map((rel) => (
          <label key={rel} className="flex items-center gap-1.5">
            <input type="radio" name="rel" value={rel} data-default="by" defaultChecked={params.rel === rel} className="size-4 accent-brand outline-none focus-visible:ring-2 focus-visible:ring-stone-500" />
            {tm(locale, rel === "by" ? "deputySearch.by" : "deputySearch.mentions")}
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <label htmlFor="deputy-q" className="sr-only">{tm(locale, "search.deputyLabel")}</label>
        <input
          id="deputy-q"
          name="q"
          type="search"
          defaultValue={params.q}
          maxLength={MAX_QUERY}
          placeholder={tm(locale, "deputySearch.placeholder")}
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500 md:text-sm"
        />
        <button
          type="submit"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 active:brightness-[0.82] focus-visible:ring-3 focus-visible:ring-stone-500"
        >
          <Search className="size-4 group-aria-busy/get:hidden" aria-hidden />
              <Spinner className="size-4 hidden group-aria-busy/get:block" />
          {tm(locale, "search.button")}
        </button>
      </div>
      <ExactBox locale={locale} checked={params.exact} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{tm(locale, "filters.from")}</span>
          <input type="date" name="from" min={min} max={max} defaultValue={params.from ?? ""} className={field} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{tm(locale, "filters.to")}</span>
          <input type="date" name="to" min={min} max={max} defaultValue={params.to ?? ""} className={field} />
        </label>
        <FormSelect
          name="phase" label={tm(locale, "filters.phase")} anyLabel={tm(locale, "filters.any")} options={phases} value={params.phase} lang="pt-BR"
          className="col-span-2 sm:col-span-1"
        />
      </div>
      {/* the sort, and the bills' and votes' filters and pages, stay as they are */}
      <KeptFields params={keptBy("speeches", params)} />
    </GetForm>
  );
}
