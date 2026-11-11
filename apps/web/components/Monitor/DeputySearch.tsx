import { Search } from "lucide-react";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, MAX_QUERY, type DeputyParams } from "@/lib/monitor/params";

const field = "h-9 w-full min-w-0 rounded-lg border border-input bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The deputy page's speech search (a GET form, works without JavaScript): this deputy's own speeches, or other
 * deputies' speeches mentioning them (the topic is optional then); dates and session phase.
 */
export function DeputySearch({ locale, externalId, params, phases }: { locale: MonitorLocale; externalId: number; params: DeputyParams; phases: string[] }) {
  const min = `${params.year}-01-01`;
  const max = `${params.year}-12-31`;
  return (
    <form role="search" action={deputyHref(externalId)} method="get" className="grid gap-3 rounded-xl border border-border bg-white p-4">
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <legend className="sr-only">{tm(locale, "deputySearch.rel")}</legend>
        {(["by", "mentions"] as const).map((rel) => (
          <label key={rel} className="flex items-center gap-1.5">
            <input type="radio" name="rel" value={rel} defaultChecked={params.rel === rel} className="size-4 accent-brand outline-none focus-visible:ring-2 focus-visible:ring-ring" />
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
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
        />
        <button
          type="submit"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Search className="size-4" aria-hidden />
          {tm(locale, "search.button")}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{tm(locale, "filters.from")}</span>
          <input type="date" name="from" min={min} max={max} defaultValue={params.from ?? ""} className={field} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{tm(locale, "filters.to")}</span>
          <input type="date" name="to" min={min} max={max} defaultValue={params.to ?? ""} className={field} />
        </label>
        <label className="col-span-2 grid gap-1 text-sm sm:col-span-1">
          <span className="text-muted-foreground">{tm(locale, "filters.phase")}</span>
          <select name="phase" defaultValue={params.phase ?? ""} className={field}>
            <option value="">{tm(locale, "filters.any")}</option>
            {phases.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      {params.sort === "new" && <input type="hidden" name="sort" value="new" />}
      {params.btype && <input type="hidden" name="btype" value={params.btype} />}
    </form>
  );
}
