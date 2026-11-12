import Link from "next/link";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";

/**
 * "1–20 of 1,556" with Previous / Next links built by `href` (which keeps every filter). Nothing when everything fits on
 * one page. `label` names the list it pages ("Speech pages"), so two pagers on a page can be told apart.
 */
export function Pager({
  locale, page, size, total, href, label,
}: { locale: MonitorLocale; page: number; size: number; total: number; href: (page: number) => string; label?: string }) {
  if (total <= size && page === 0) return null;
  const from = Math.min(total, page * size + 1);
  const to = Math.min(total, (page + 1) * size);
  const link = "rounded px-1 font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500";
  return (
    <nav aria-label={label ?? tm(locale, "paging.label")} className="flex items-center justify-between gap-2 px-1 pt-2 text-sm">
      <span className="text-muted-foreground">{tm(locale, "paging.range", { from: formatCount(from, locale), to: formatCount(to, locale), total: formatCount(total, locale) })}</span>
      <span className="flex gap-3">
        {page > 0 && <Link href={href(page - 1)} className={link}>{tm(locale, "paging.previous")}</Link>}
        {to < total && <Link href={href(page + 1)} className={link}>{tm(locale, "paging.next")}</Link>}
      </span>
    </nav>
  );
}
