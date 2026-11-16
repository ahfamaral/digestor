import { differsFromGuidance } from "@digestor/core";
import type { VoteRow as Vote } from "@digestor/core/server";
import Link from "next/link";
import { formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { rollCallHref } from "@/lib/monitor/params";
import { billUrl } from "@/lib/monitor/search";
import { isRequestVote } from "@/lib/monitor/votes";
import { ExternalLink } from "./ExternalLink";
import { ByMeaning } from "./MeaningNote";

/**
 * One recorded vote: what was voted (the roll call's published description) first, then the bill it belongs to (opens
 * the roll-call page; the bill on the Câmara's site) and its summary, and the vote exactly as published. A vote on a
 * request is marked, since a "Não" on it is not a vote against the bill. The guidance that applied to the party at the
 * vote sits under the vote, as published, with the federation or bloc it came from. `from`: the deputy whose page lists
 * it, so the roll-call page leads back to them. A vote only the search by meaning found is marked "Close in meaning".
 * The deputy's vote reads "Voted: Não"; when it differs from a directed guidance (the `vdiff` rule,
 * `differsFromGuidance`), a neutral text tag says so (never colour alone, never a judgement).
 */
export function VoteRow({ locale, vote: v, from }: { locale: MonitorLocale; vote: Vote & { byMeaning?: boolean }; from?: number }) {
  return (
    <li className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)] sm:gap-x-4">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <time dateTime={v.date} className="font-mono text-xs text-muted-foreground">
            {formatDay(v.date, locale)}
          </time>
          <Link href={rollCallHref(v.rollCallId, { from })} className="font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
            {v.billLabel ?? tm(locale, "rollCall.noBill")}
          </Link>
          {v.billLabel && v.billId && (
            <ExternalLink href={billUrl(v.billId)} className="text-xs whitespace-nowrap">
              {tm(locale, "member.officialRecord")}
            </ExternalLink>
          )}
          {isRequestVote(v.description, v.billLabel) && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{tm(locale, "votes.request")}</span>
          )}
          {v.byMeaning && <ByMeaning locale={locale} />}
        </div>
        <p lang="pt-BR" className="break-words whitespace-pre-line">
          {v.description}
        </p>
        {v.billSummary && (
          <p lang="pt-BR" className="break-words text-muted-foreground">{v.billSummary}</p>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:flex-col sm:items-end">
        <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          {tm(locale, "votes.voted")}
          <span lang="pt-BR" title={v.vote === "Artigo 17" ? tm(locale, "rollCallPage.artigo17") : undefined} className="h-fit w-fit rounded-full border border-border bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-foreground">{v.vote}</span>
        </span>
        {v.guidance && (
          <span className="text-xs text-muted-foreground sm:text-right">
            {tm(locale, "votes.guidance")} <span lang="pt-BR" className="font-semibold text-foreground">{v.guidance}</span>
            {v.guidanceFrom && <> {tm(locale, /^Fdr\s/i.test(v.guidanceFrom) ? "votes.viaFederation" : "votes.viaBloc", { label: v.guidanceFrom })}</>}
          </span>
        )}
        {differsFromGuidance(v.vote, v.guidance) && (
          <span className="w-fit rounded border border-stone-400 px-1.5 py-px text-xs font-medium text-foreground">
            {tm(locale, "votes.differs")}
          </span>
        )}
      </div>
    </li>
  );
}
