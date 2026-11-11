import Link from "next/link";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/** "1–20 of 48" with Newer / Older links that keep the query. Nothing when everything fits on one page. */
export function Pager({ locale, base, q, page, size, total }: { locale: MonitorLocale; base: string; q: string; page: number; size: number; total: number }) {
  if (total <= size && page === 0) return null;
  const href = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (p > 0) sp.set("p", String(p));
    const s = sp.toString();
    return s ? `${base}?${s}` : base;
  };
  const from = Math.min(total, page * size + 1);
  const to = Math.min(total, (page + 1) * size);
  const link = "rounded px-1 font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <nav aria-label={tm(locale, "paging.label")} className="flex items-center justify-between gap-2 px-1 pt-2 text-sm">
      <span className="text-muted-foreground">{tm(locale, "paging.range", { from, to, total })}</span>
      <span className="flex gap-3">
        {page > 0 && <Link href={href(page - 1)} className={link}>{tm(locale, "paging.newer")}</Link>}
        {to < total && <Link href={href(page + 1)} className={link}>{tm(locale, "paging.older")}</Link>}
      </span>
    </nav>
  );
}
