import type { VoteRow as Vote } from "@digestor/core/server";
import { formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import Link from "next/link";
import { rollCallHref } from "@/lib/monitor/params";
import { billUrl } from "@/lib/monitor/search";
import { ExternalLink } from "./ExternalLink";

/** One recorded vote: the roll call (opens its page; the bill on the Câmara's site), what was voted, and the vote exactly as published. */
export function VoteRow({ locale, vote: v }: { locale: MonitorLocale; vote: Vote }) {
  return (
    <li className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[1fr_auto] sm:gap-x-4">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <time dateTime={v.date} className="font-mono text-xs text-muted-foreground">
            {formatDay(v.date, locale)}
          </time>
          <Link href={rollCallHref(v.rollCallId)} className="font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {v.billLabel ?? tm(locale, "rollCall.noBill")}
          </Link>
          {v.billLabel && v.billId && (
            <ExternalLink href={billUrl(v.billId)} className="text-xs">
              {tm(locale, "member.officialRecord")}
            </ExternalLink>
          )}
        </div>
        {v.billSummary && (
          <p lang="pt-BR" className="break-words">
            {v.billSummary}
          </p>
        )}
        <p lang="pt-BR" className="break-words whitespace-pre-line text-muted-foreground">
          {v.description}
        </p>
      </div>
      <span lang="pt-BR" className="h-fit w-fit rounded-full border border-border bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-foreground sm:self-start">{v.vote}</span>
    </li>
  );
}
