import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { RollCallDetail } from "@digestor/core/server";
import { formatCount, formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, rollCallHref } from "@/lib/monitor/params";
import { billUrl } from "@/lib/monitor/search";
import { bySmallestGroup, isRequestVote } from "@/lib/monitor/votes";
import { ExternalLink } from "./ExternalLink";
import { LanguageSwitch } from "./LanguageSwitch";
import { ReturnLink } from "./ReturnLink";
import { cn } from "@/lib/utils";

/**
 * A plenary roll call as published: the bill, what was voted, the totals, every recorded vote grouped by the voter's
 * party at the time of the vote, and the parties' and blocs' guidance. No cohesion or other scores.
 * `back`: the deputy page it was opened from (their name, back to their votes); else the monitor. That deputy's vote is
 * repeated under the header, their party opens and their row is marked. Inside a party the smallest vote group comes first.
 */
export function RollCallView({
  locale, rollCall: r, back, from, search,
}: { locale: MonitorLocale; rollCall: RollCallDetail; back?: { href: string; label: string }; from?: number; search?: string }) {
  const n = (v: number) => formatCount(v, locale);
  const mine = from === undefined ? null : r.parties.flatMap((p) => p.deputies).find((d) => d.externalId === from) ?? null;
  return (
    <div lang={locale} className="grid gap-8">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ReturnLink href={back?.href ?? "/monitor"} label={back?.label ?? tm(locale, "member.back")} />
          <LanguageSwitch locale={locale} back={rollCallHref(r.id, { from, back: search })} />
        </div>
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-bold tracking-tight">{r.billLabel ?? tm(locale, "rollCall.noBill")}</h1>
            {r.billId && (
              <ExternalLink href={billUrl(r.billId)} className="text-sm">
                {tm(locale, "member.officialRecord")}
              </ExternalLink>
            )}
          </div>
          {isRequestVote(r.description, r.billLabel) && (
            <span className="w-fit rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{tm(locale, "votes.request")}</span>
          )}
          <p lang="pt-BR" className="break-words whitespace-pre-line">{r.description}</p>
          {r.billSummary && <p lang="pt-BR" className="break-words text-muted-foreground">{r.billSummary}</p>}
          <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
            <time dateTime={r.date}>{formatDay(r.date, locale)}</time>
            <span>{tm(locale, "rollCall.totals", { yes: n(r.yes), no: n(r.no), other: n(r.other) })}</span>
          </p>
          {mine && (
            <p className="text-sm">
              {mine.name}: <span lang="pt-BR" className="rounded-full border border-border bg-stone-100 px-2.5 py-0.5 text-xs font-semibold">{mine.vote}</span>
            </p>
          )}
        </div>
      </div>

      <section className="grid gap-2" aria-labelledby="by-party">
        <h2 id="by-party" className="text-base font-semibold">{tm(locale, "rollCallPage.byParty")}</h2>
        <p className="text-xs text-muted-foreground">{tm(locale, "rollCallPage.partyNote")}</p>
        <ul className="grid gap-2">
          {r.parties.map((p) => (
            <li key={p.party ?? "none"}>
              <details open={!!mine && p.deputies.some((d) => d.externalId === mine.externalId)} className="group rounded-xl border border-border bg-white">
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-xl px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-stone-500">
                  <ChevronRight className="size-4 shrink-0 self-center text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
                  <span className="font-semibold">{p.party ?? tm(locale, "rollCallPage.noParty")}</span>
                  <span className="text-muted-foreground">
                    {p.deputies.length === 1 ? tm(locale, "rollCallPage.deputiesOne") : tm(locale, "rollCallPage.deputies", { n: n(p.deputies.length) })}
                  </span>
                  <span lang="pt-BR" className="font-mono text-xs">{p.counts.map((c) => `${c.vote} ${n(c.n)}`).join(" · ")}</span>
                </summary>
                <ul className="divide-y divide-border border-t border-border">
                  {bySmallestGroup(p.deputies).map((d) => (
                    <li
                      key={d.externalId}
                      aria-current={d.externalId === mine?.externalId ? "true" : undefined}
                      className={cn("flex items-baseline justify-between gap-3 px-4 py-2 text-sm", d.externalId === mine?.externalId && "bg-muted")}
                    >
                      <span className="min-w-0 break-words">
                        <Link href={deputyHref(d.externalId)} className="font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
                          {d.name}
                        </Link>
                        {d.uf && <span className="text-muted-foreground"> · {d.uf}</span>}
                      </span>
                      <span lang="pt-BR" className="shrink-0 rounded-full border border-border bg-stone-100 px-2.5 py-0.5 text-xs font-semibold">{d.vote}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </section>

      {r.orientations.length > 0 && (
        <section className="grid gap-2" aria-labelledby="guidance">
          <h2 id="guidance" className="text-base font-semibold">{tm(locale, "rollCallPage.guidance")}</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-white">
            {r.orientations.map((o) => (
              <li key={o.bloc} className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                <span lang="pt-BR" className="grid min-w-0 break-words">
                  {o.bloc}
                  {o.blocName && <span className="text-xs text-muted-foreground">{o.blocName}</span>}
                </span>
                <span lang="pt-BR" className={o.orientation ? "shrink-0 font-semibold" : "shrink-0 text-muted-foreground"}>
                  {o.orientation || tm(locale, "rollCallPage.noGuidance")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
