import Link from "next/link";
import type { RollCallDetail } from "@digestor/core/server";
import { BackLink } from "@/components/BackLink";
import { formatCount, formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, rollCallHref } from "@/lib/monitor/params";
import { billUrl } from "@/lib/monitor/search";
import { ExternalLink } from "./ExternalLink";
import { LanguageSwitch } from "./LanguageSwitch";

/**
 * A plenary roll call as published: the bill, what was voted, the totals, every recorded vote grouped by the voter's
 * party at the time of the vote, and the parties' and blocs' guidance. No cohesion or other scores.
 */
export function RollCallView({ locale, rollCall: r }: { locale: MonitorLocale; rollCall: RollCallDetail }) {
  const n = (v: number) => formatCount(v, locale);
  return (
    <div lang={locale} className="grid gap-8">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <BackLink href="/monitor" label={tm(locale, "member.back")} />
          <LanguageSwitch locale={locale} back={rollCallHref(r.id)} />
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
          {r.billSummary && <p lang="pt-BR" className="break-words">{r.billSummary}</p>}
          <p lang="pt-BR" className="break-words whitespace-pre-line text-muted-foreground">{r.description}</p>
          <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
            <time dateTime={r.date}>{formatDay(r.date, locale)}</time>
            <span>{tm(locale, "rollCall.totals", { yes: n(r.yes), no: n(r.no), other: n(r.other) })}</span>
          </p>
        </div>
      </div>

      <section className="grid gap-2" aria-labelledby="by-party">
        <h2 id="by-party" className="text-base font-semibold">{tm(locale, "rollCallPage.byParty")}</h2>
        <p className="text-xs text-muted-foreground">{tm(locale, "rollCallPage.partyNote")}</p>
        <ul className="grid gap-2">
          {r.parties.map((p) => (
            <li key={p.party ?? "none"}>
              <details className="rounded-xl border border-border bg-white">
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-xl px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="font-semibold">{p.party ?? tm(locale, "rollCallPage.noParty")}</span>
                  <span className="text-muted-foreground">
                    {p.deputies.length === 1 ? tm(locale, "rollCallPage.deputiesOne") : tm(locale, "rollCallPage.deputies", { n: n(p.deputies.length) })}
                  </span>
                  <span lang="pt-BR" className="font-mono text-xs">{p.counts.map((c) => `${c.vote} ${n(c.n)}`).join(" · ")}</span>
                </summary>
                <ul className="divide-y divide-border border-t border-border">
                  {p.deputies.map((d) => (
                    <li key={d.externalId} className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                      <span className="min-w-0 break-words">
                        <Link href={deputyHref(d.externalId)} className="font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
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
                <span lang="pt-BR" className="min-w-0 break-words">{o.bloc}</span>
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
