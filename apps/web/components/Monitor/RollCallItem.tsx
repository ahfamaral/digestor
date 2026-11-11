import type { RollCallHit } from "@digestor/core/server";
import { formatCount, formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { billUrl } from "@/lib/monitor/search";
import { ExternalLink } from "./ExternalLink";
import { Highlighted } from "./Highlighted";

/** A roll call in search results: the bill, what was voted and the totals. Never any deputy's vote. */
export function RollCallItem({ locale, rollCall: r }: { locale: MonitorLocale; rollCall: RollCallHit }) {
  const n = (v: number) => formatCount(v, locale);
  return (
    <li className="grid gap-1.5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {r.billLabel && r.billId ? (
          <ExternalLink href={billUrl(r.billId)} className="font-semibold">
            {r.billLabel}
          </ExternalLink>
        ) : (
          <span className="font-semibold">{r.billLabel ?? tm(locale, "rollCall.noBill")}</span>
        )}
        <time dateTime={r.date} className="font-mono text-xs text-muted-foreground">
          {formatDay(r.date, locale)}
        </time>
      </div>
      <p lang="pt-BR" className="break-words">
        <Highlighted text={r.snippet} />
      </p>
      <p className="font-mono text-xs text-muted-foreground">{tm(locale, "rollCall.totals", { yes: n(r.yes), no: n(r.no), other: n(r.other) })}</p>
    </li>
  );
}
