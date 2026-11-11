"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { MONITOR_YEARS } from "@/lib/monitor/params";

/** The year of the records (only 2026 for now). `hrefs` holds the current page's URL for each year. */
export function YearSelect({ locale, year, hrefs }: { locale: MonitorLocale; year: number; hrefs: Record<number, string> }) {
  const router = useRouter();
  return (
    <Select<number>
      value={year}
      onValueChange={(y) => {
        if (y !== null && y !== year && hrefs[y]) router.push(hrefs[y]);
      }}
    >
      <SelectTrigger aria-label={tm(locale, "year.label")} className="bg-white font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MONITOR_YEARS.map((y) => (
          <SelectItem key={y} value={y} className="font-mono">
            {y}
          </SelectItem>
        ))}
        <p className="px-1.5 py-1 text-xs text-muted-foreground">{tm(locale, "year.only")}</p>
      </SelectContent>
    </Select>
  );
}
