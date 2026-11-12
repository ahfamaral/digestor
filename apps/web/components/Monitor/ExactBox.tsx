import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/** "Exact words only" in a GET search form: `exact=1` skips translation and related terms. */
export function ExactBox({ locale, checked }: { locale: MonitorLocale; checked: boolean }) {
  return (
    <label className="flex w-fit items-center gap-1.5 text-sm">
      <input
        type="checkbox"
        name="exact"
        value="1"
        defaultChecked={checked}
        className="size-4 rounded border-input accent-brand outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
      />
      {tm(locale, "search.exact")}
    </label>
  );
}
