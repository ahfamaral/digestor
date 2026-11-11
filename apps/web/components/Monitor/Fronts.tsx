import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/** The parliamentary fronts of this legislature the deputy joined, folded. */
export function Fronts({ locale, fronts }: { locale: MonitorLocale; fronts: string[] }) {
  if (fronts.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="fronts-title">
      <h2 id="fronts-title" className="text-base font-semibold">{tm(locale, "fronts.title")}</h2>
      <details className="rounded-xl border border-border bg-white">
        <summary className="cursor-pointer rounded-xl px-4 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {tm(locale, "fronts.members", { n: fronts.length })}
        </summary>
        <ul lang="pt-BR" className="grid gap-1 border-t border-border px-4 py-3 text-sm">
          {fronts.map((f, i) => (
            <li key={i} className="break-words">{f}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
