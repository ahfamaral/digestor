import Link from "next/link";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { landingHref, type LandingParams } from "@/lib/monitor/params";
import { cn } from "@/lib/utils";

/** Best match | Newest first: two links that keep every filter and go back to the first page. */
export function SortSwitch({ locale, params }: { locale: MonitorLocale; params: LandingParams }) {
  const options: ["best" | "new", string][] = [["best", tm(locale, "sort.best")], ["new", tm(locale, "sort.new")]];
  return (
    <nav aria-label={tm(locale, "sort.label")} className="flex items-center gap-1 text-sm">
      <span className="mr-1 text-muted-foreground">{tm(locale, "sort.label")}:</span>
      {options.map(([value, label], i) => (
        <span key={value} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-muted-foreground">|</span>}
          <Link
            href={landingHref({ ...params, sort: value, p: 0, rp: 0 })}
            aria-current={params.sort === value ? "true" : undefined}
            className={cn(
              "rounded px-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
              params.sort === value ? "font-semibold" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
