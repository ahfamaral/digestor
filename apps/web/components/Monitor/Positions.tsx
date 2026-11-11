import type { Position } from "@digestor/core";
import { formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";

const MEMBERSHIP = new Set(["Titular", "Suplente"]);

/** Seats in bodies since 1 Feb 2023: leading roles (Presidente, Relator…) first; plain memberships folded. */
export function Positions({ locale, positions, today }: { locale: MonitorLocale; positions: Position[]; today: string }) {
  if (positions.length === 0) return null;
  const newest = [...positions].sort((a, b) => (b.to ?? "9999").localeCompare(a.to ?? "9999") || b.from.localeCompare(a.from));
  const leading = newest.filter((p) => !MEMBERSHIP.has(p.title));
  const members = newest.filter((p) => MEMBERSHIP.has(p.title));
  const bodies = new Set(members.map((p) => p.body)).size;
  const row = (p: Position, i: number) => {
    const now = p.to === null || p.to >= today;
    return (
      <li key={i} className="grid gap-0.5 px-4 py-2.5 text-sm sm:grid-cols-[1fr_auto] sm:gap-x-4">
        <span className="min-w-0 break-words">
          <span className="font-semibold" lang="pt-BR">{p.title}</span> · <span lang="pt-BR">{p.bodyName}</span>
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {now ? `${formatDay(p.from, locale)} – ${tm(locale, "positions.now")}` : tm(locale, "timeline.range", { from: formatDay(p.from, locale), to: formatDay(p.to!, locale) })}
        </span>
      </li>
    );
  };
  return (
    <section className="grid gap-2" aria-labelledby="positions-title">
      <h2 id="positions-title" className="text-base font-semibold">{tm(locale, "positions.title")}</h2>
      {leading.length > 0 && <ul className="divide-y divide-border rounded-xl border border-border bg-white">{leading.map(row)}</ul>}
      {members.length > 0 && (
        <details className="rounded-xl border border-border bg-white">
          <summary className="cursor-pointer rounded-xl px-4 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {bodies === 1 ? tm(locale, "positions.membersOne") : tm(locale, "positions.members", { n: bodies })}
          </summary>
          <ul className="divide-y divide-border border-t border-border">{members.map(row)}</ul>
        </details>
      )}
    </section>
  );
}
