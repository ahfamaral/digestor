import Link from "next/link";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { landingHref, type LandingParams } from "@/lib/monitor/params";

export type Facets = { parties: string[]; ufs: string[]; phases: string[] };

const field = "h-9 w-full min-w-0 rounded-lg border border-input bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const box = "size-4 rounded border-input accent-brand outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The topic search's filters, inside its GET form: native inputs and selects, so the form works without JavaScript.
 * Party and state are the speaker's on the day of the speech.
 */
export function TopicFilters({ locale, params, facets }: { locale: MonitorLocale; params: LandingParams; facets: Facets }) {
  const min = `${params.year}-01-01`;
  const max = `${params.year}-12-31`;
  const select = (name: "party" | "uf" | "phase", label: string, options: string[], value: string | null) => (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select name={name} defaultValue={value ?? ""} className={field}>
        <option value="">{tm(locale, "filters.any")}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset className="grid gap-3">
      <legend className="sr-only">{tm(locale, "filters.legend")}</legend>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-muted-foreground">{tm(locale, "filters.show")}</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="show" value="speeches" defaultChecked={params.show.speeches} className={box} />
          {tm(locale, "filters.speeches")}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="show" value="rollcalls" defaultChecked={params.show.rollCalls} className={box} />
          {tm(locale, "filters.rollCalls")}
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{tm(locale, "filters.from")}</span>
          <input type="date" name="from" min={min} max={max} defaultValue={params.from ?? ""} className={field} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{tm(locale, "filters.to")}</span>
          <input type="date" name="to" min={min} max={max} defaultValue={params.to ?? ""} className={field} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {select("party", tm(locale, "filters.party"), facets.parties, params.party)}
        {select("uf", tm(locale, "filters.uf"), facets.ufs, params.uf)}
        {select("phase", tm(locale, "filters.phase"), facets.phases, params.phase)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="inOffice" value="1" defaultChecked={params.inOffice} className={box} />
          {tm(locale, "filters.inOffice")}
        </label>
        <Link href={landingHref({ q: params.q })} className="rounded px-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {tm(locale, "filters.clear")}
        </Link>
      </div>
    </fieldset>
  );
}
