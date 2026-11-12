import type { RollCallHit } from "@digestor/core/server";
import { formatCount, formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import Link from "next/link";
import { rollCallHref } from "@/lib/monitor/params";
import { billUrl } from "@/lib/monitor/search";
import { ExternalLink } from "./ExternalLink";
import { Highlighted } from "./Highlighted";

/**
 * A roll call in search results: what was voted (opens the roll-call page), the bill on the Câmara's site, the totals.
 * `back`: the search's address, so the roll-call page leads back to it.
 */
export function RollCallItem({ locale, rollCall: r, back }: { locale: MonitorLocale; rollCall: RollCallHit; back?: string }) {
  const n = (v: number) => formatCount(v, locale);
  return (
    <li className="grid gap-1.5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Link href={rollCallHref(r.id, { back })} className="font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
          {r.billLabel ?? tm(locale, "rollCall.noBill")}
        </Link>
        {r.billLabel && r.billId && (
          <ExternalLink href={billUrl(r.billId)} className="text-xs">
            {tm(locale, "member.officialRecord")}
          </ExternalLink>
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
