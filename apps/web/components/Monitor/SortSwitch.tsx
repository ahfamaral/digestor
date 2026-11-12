import Link from "next/link";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { cn } from "@/lib/utils";

/** Best match | Newest first: two links; `href` builds each (keeping every filter, back to the first page). */
export function SortSwitch({ locale, sort, href }: { locale: MonitorLocale; sort: "best" | "new"; href: (sort: "best" | "new") => string }) {
  const options: ["best" | "new", string][] = [["best", tm(locale, "sort.best")], ["new", tm(locale, "sort.new")]];
  return (
    <nav aria-label={tm(locale, "sort.label")} className="flex items-center gap-1 text-sm">
      <span className="mr-1 text-muted-foreground">{tm(locale, "sort.label")}:</span>
      {options.map(([value, label], i) => (
        <span key={value} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-muted-foreground">|</span>}
          <Link
            href={href(value)}
            aria-current={sort === value ? "true" : undefined}
            className={cn(
              "rounded px-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500",
              sort === value ? "font-semibold" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
