"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PROFILES, ProfileIdSchema, chamberLabel, formatLength } from "@digestor/core";
import type { ClipPreview } from "@digestor/core/server";
import { ClipStrip } from "@/components/Home/ClipStrip";
import { Busy } from "@/components/ui/spinner";
import {
  DEFAULT_FILTERS, addedDate, bodyChips, clipCellText, filterRows, filtersToQuery, goTo, needsYou, scopeRows, typeTabs, whereItIs,
  type HomeFilters, type HomeRow, type StatusFilter,
} from "@/lib/home";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ClipPreviewView = ClipPreview & { thumbUrl: string | null };

const CHIP = "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
const chip = (on: boolean) => cn(CHIP, on ? "border-foreground bg-foreground text-white" : "border-border bg-white text-foreground hover:bg-muted");
const TONE = { normal: "text-foreground", busy: "text-foreground", waiting: "font-medium text-violet-700", failed: "font-medium text-destructive" } as const;

const STATUS_CHIPS: { id: StatusFilter; key: Parameters<typeof t>[0] }[] = [
  { id: "any", key: "home.statusAny" },
  { id: "needs_you", key: "home.statusNeedsYou" },
  { id: "to_export", key: "home.statusToExport" },
  { id: "processing", key: "home.statusProcessing" },
  { id: "failed", key: "home.statusFailed" },
  { id: "ready", key: "home.statusReady" },
];

/** The Sessions table: needs-you strip, type tabs, filters (kept in the URL), and one row per video with its clips. */
export function HomeTable({ rows, clips, now, initial, limit, spent = null }: {
  rows: HomeRow[];
  clips: Record<string, ClipPreviewView[]>;
  now: string;
  initial: HomeFilters;
  /** The most videos the page loads; a list that hits it says so. */
  limit: number;
  /** "Spent so far" over every session (recorded where stored, estimated elsewhere); null when nothing was spent. */
  spent?: { total: string; detail: string } | null;
}) {
  const [f, setF] = useState<HomeFilters>(initial);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const shown = useMemo(() => filterRows(rows, f, new Date(now)), [rows, f, now]);
  const counts = useMemo(() => needsYou(scopeRows(rows, f)), [rows, f.type, f.body]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = typeTabs(rows);
  const bodies = bodyChips(rows);
  const parliament = f.type === "parliament";

  function update(next: Partial<HomeFilters>) {
    const merged = { ...f, ...next };
    if (merged.type !== "parliament") merged.body = "all";
    setF(merged);
    const qs = filtersToQuery(merged);
    window.history.replaceState(null, "", qs ? `/?${qs}` : "/");
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-white p-6 text-center">
        <p className="mb-4 text-sm text-muted-foreground">{t("home.empty")}</p>
        <Link href="/new" className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground">
          {t("home.newVideo")}
        </Link>
      </div>
    );
  }

  const strip: { id: Exclude<StatusFilter, "any" | "ready">; n: number; key: Parameters<typeof t>[0] }[] = [
    { id: "needs_you", n: counts.needs_you, key: "home.needsContext" },
    { id: "to_export", n: counts.to_export, key: "home.needsExport" },
    { id: "failed", n: counts.failed, key: "home.needsFailed" },
    { id: "processing", n: counts.processing, key: "home.needsProcessing" },
  ];

  const typeLabel = (r: HomeRow) => {
    if (parliament) return r.chamber ? chamberLabel(r.chamber) : t("home.bodyUnlinked");
    const p = ProfileIdSchema.safeParse(r.profile);
    return p.success ? PROFILES[p.data].label : "";
  };
  const subLine = (r: HomeRow) =>
    [r.source === "youtube" ? t("home.youtube") : t("home.upload"), r.durationMs ? formatLength(r.durationMs) : null, r.videoRemoved ? t("home.videoRemoved") : null]
      .filter(Boolean)
      .join(" · ");

  const toggle = (r: HomeRow) =>
    (clips[r.id]?.length ?? 0) > 0 ? (
      <button
        type="button"
        aria-expanded={open[r.id] ?? false}
        aria-label={t(open[r.id] ? "home.hideClips" : "home.showClips", { title: r.title })}
        onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open[r.id] ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
      </button>
    ) : null;

  const where = (r: HomeRow) => {
    const w = whereItIs(r);
    return (
      <span className={cn("inline-flex items-center text-xs", TONE[w.tone])}>
        <Busy busy={w.tone === "busy"}>{w.text}</Busy>
      </span>
    );
  };

  const links = (r: HomeRow) => (
    <span className="flex flex-wrap gap-1 @min-[60rem]:flex-nowrap">
      {goTo(r).map((g) =>
        g.href ? (
          <Link key={g.step} href={g.href} className="inline-flex h-8 items-center rounded-md border border-border bg-white px-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            {t(`appBar.step.${g.step}`)}
          </Link>
        ) : (
          <span key={g.step} aria-disabled="true" className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs text-muted-foreground/60">
            {t(`appBar.step.${g.step}`)}
          </span>
        ),
      )}
    </span>
  );

  const title = (r: HomeRow) => (
    <Link href={whereItIs(r).href} lang={r.language ?? undefined} dir="auto" className="font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
      {r.title}
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {strip.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={f.status === s.id}
            onClick={() => update({ status: f.status === s.id ? "any" : s.id })}
            className={cn(
              "flex flex-col items-start rounded-xl border bg-white px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              f.status === s.id ? "border-foreground" : "border-border hover:bg-muted/50",
            )}
          >
            <span className="text-lg font-bold">{s.n}</span>
            <span className="text-muted-foreground">{t(s.key)}</span>
          </button>
        ))}
      </div>
      {spent && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {spent.total} <span aria-hidden>·</span> {spent.detail}
        </p>
      )}

      {/* One row that scrolls sideways on a narrow screen (never wraps); the bottom line is a shadow so the scroll box doesn't clip the active tab's rule. */}
      <nav aria-label={t("home.tabsLabel")} className="flex gap-1 overflow-x-auto text-sm shadow-[inset_0_-1px_0_var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={f.type === tab.id}
            onClick={() => update({ type: tab.id })}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              f.type === tab.id ? "border-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label} <span className="font-normal text-muted-foreground">{tab.count}</span>
          </button>
        ))}
      </nav>

      <div className="flex flex-col gap-2">
        <input
          type="search"
          value={f.q}
          onChange={(e) => update({ q: e.target.value })}
          placeholder={t("home.search")}
          aria-label={t("home.search")}
          className="h-9 w-full rounded-lg border border-border bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-xs"
        />
        {parliament && (
          <div role="group" aria-label={t("home.bodyLabel")} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">{t("home.bodyLabel")}</span>
            {bodies.map((b) => (
              <button key={b.id} type="button" aria-pressed={f.body === b.id} onClick={() => update({ body: b.id })} className={chip(f.body === b.id)}>
                {b.label} {b.id !== "all" && <span className="opacity-60">{b.count}</span>}
              </button>
            ))}
          </div>
        )}
        <div role="group" aria-label={t("home.statusLabel")} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">{t("home.statusLabel")}</span>
          {STATUS_CHIPS.map((s) => (
            <button key={s.id} type="button" aria-pressed={f.status === s.id} onClick={() => update({ status: s.id })} className={chip(f.status === s.id)}>
              {t(s.key)}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <button type="button" aria-pressed={f.clips} onClick={() => update({ clips: !f.clips })} className={chip(f.clips)}>
            {t("home.hasClips")}
          </button>
          <button type="button" aria-pressed={f.recent} onClick={() => update({ recent: !f.recent })} className={chip(f.recent)}>
            {t("home.recent")}
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-border bg-white p-6 text-center text-sm">
          <p className="mb-3 text-muted-foreground">{t("home.noMatch")}</p>
          <button type="button" onClick={() => update(DEFAULT_FILTERS)} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted">
            {t("home.clearFilters")}
          </button>
        </div>
      ) : (
        // Table or stacked rows by the width this list gets, not the window's: the "Ask across videos" panel takes 28 rem
        // beside the page, and a table squeezed below its natural width (about 60 rem) scrolled sideways.
        <div className="@container">
          {/* Wide enough: a table (overflow-x-auto is only a last resort for an unusually wide cell). */}
          <div className="hidden min-w-0 overflow-x-auto rounded-xl border border-border bg-white @min-[60rem]:block">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs whitespace-nowrap text-muted-foreground">
              <tr>
                <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">{t("home.colToggle")}</span></th>
                <th scope="col" className="px-2 py-2 font-medium">{t("home.colVideo")}</th>
                <th scope="col" className="px-2 py-2 font-medium">{parliament ? t("home.colBody") : t("home.colType")}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t("home.colAdded")}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t("home.colWhere")}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t("home.colClips")}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t("home.colGo")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.id}>
                  <tr className="border-t border-border align-middle">
                    <td className="px-2 py-2">{toggle(r)}</td>
                    <td className="px-2 py-2">
                      <div className="max-w-56 truncate lg:max-w-64">{title(r)}</div>
                      <div className="text-xs text-muted-foreground">{subLine(r)}</div>
                    </td>
                    <td className="px-2 py-2">
                      {typeLabel(r) && <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs whitespace-nowrap">{typeLabel(r)}</span>}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">{addedDate(r.createdAt)}</td>
                    <td className="min-w-32 px-2 py-2">{where(r)}</td>
                    <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">{clipCellText(r)}</td>
                    <td className="px-2 py-2">{links(r)}</td>
                  </tr>
                  {open[r.id] && clips[r.id] && (
                    <tr className="bg-muted/30">
                      <td />
                      <td colSpan={6} className="px-2 py-2">
                        <ClipStrip sessionId={r.id} clips={clips[r.id]!} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>

          {/* Narrower: stacked rows. */}
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-white @min-[60rem]:hidden">
            {shown.map((r) => (
              <li key={r.id} className="flex flex-col gap-1.5 px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words">{title(r)}</div>
                    <div className="text-xs text-muted-foreground">
                      {[typeLabel(r), addedDate(r.createdAt), subLine(r)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {toggle(r)}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {where(r)}
                  <span className="font-mono text-muted-foreground">{t("home.colClips")}: {clipCellText(r)}</span>
                </div>
                {links(r)}
                {open[r.id] && clips[r.id] && <ClipStrip sessionId={r.id} clips={clips[r.id]!} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {rows.length >= limit && <p className="text-center text-xs text-muted-foreground">{t("home.capped", { n: limit })}</p>}
    </div>
  );
}
