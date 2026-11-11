import Link from "next/link";
import type { MemberBill } from "@digestor/core/server";
import { formatCount, formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, type DeputyParams } from "@/lib/monitor/params";
import { billUrl } from "@/lib/monitor/search";
import { cn } from "@/lib/utils";
import { ExternalLink } from "./ExternalLink";
import { Pager } from "./Pager";
import { Section } from "./Section";

export const BILL_PAGE = 20;
const label = (b: MemberBill) => (b.year ? `${b.type} ${b.number}/${b.year}` : `${b.type} ${b.number}`);

/** Bills and requests the deputy signed in the year: counts by type (each a filter), the list, co-authorship marked. */
export function AuthoredBills({
  locale, externalId, params, bills,
}: { locale: MonitorLocale; externalId: number; params: DeputyParams; bills: { total: number; byType: { type: string; n: number }[]; rows: MemberBill[] } }) {
  const all = bills.byType.reduce((s, r) => s + r.n, 0);
  const filter = (type: string | null, text: string) => (
    <Link
      key={type ?? "all"}
      href={deputyHref(externalId, { ...params, btype: type, bp: 0 })}
      aria-current={params.btype === type ? "true" : undefined}
      className={cn(
        "rounded px-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        params.btype === type ? "font-semibold" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {text}
    </Link>
  );
  const toolbar = bills.byType.length > 1 && (
    <nav aria-label={tm(locale, "bills.types")} className="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-xs">
          {filter(null, `${tm(locale, "bills.all")} ${formatCount(all, locale)}`)}
          {bills.byType.map((t) => (
            <span key={t.type} className="flex items-center gap-1">
              <span aria-hidden className="text-muted-foreground">·</span>
              {filter(t.type, `${t.type} ${formatCount(t.n, locale)}`)}
            </span>
          ))}
        </nav>
  );
  return (
    <div className="grid gap-2">
      <div className="grid">
        <Section
          title={tm(locale, "bills.title")}
          count={bills.total ? formatCount(bills.total, locale) : undefined}
          empty={bills.total ? null : tm(locale, "bills.empty", { year: params.year })}
          toolbar={toolbar}
        >
          {bills.rows.map((b) => (
            <li key={b.id} className="grid gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <ExternalLink href={billUrl(b.id)} className="font-semibold">{label(b)}</ExternalLink>
                <time dateTime={b.presentedAt} className="font-mono text-xs text-muted-foreground">{formatDay(b.presentedAt.slice(0, 10), locale)}</time>
                {!b.firstAuthor && <span className="text-xs text-muted-foreground">{tm(locale, "bills.coAuthor")}</span>}
              </div>
              {b.summary && <p lang="pt-BR" className="break-words">{b.summary}</p>}
            </li>
          ))}
        </Section>
        <Pager locale={locale} page={params.bp} size={BILL_PAGE} total={bills.total} href={(bp) => deputyHref(externalId, { ...params, bp })} />
      </div>
    </div>
  );
}
