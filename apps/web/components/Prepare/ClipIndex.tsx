"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { formatTimestamp } from "@digestor/core";
import type { ClipStatus } from "@/lib/prepareData";
import { ClipStatusBadge } from "./ClipStatusBadge";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export interface ClipIndexEntry {
  id: string;
  n: number;
  title: string;
  startMs: number;
  status: ClipStatus;
  dismissed: boolean;
}

/**
 * The clip index: number, time and status per clip, each a link to its card (`#clip-<id>`). A sticky side column from
 * `lg` up; below that a "Clips (N)" bar that opens the same list.
 */
export function ClipIndex({ entries, language }: { entries: ClipIndexEntry[]; language: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <nav aria-label={t("prepare.indexLabel")} className="mb-3 lg:sticky lg:top-20 lg:mb-0 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="clip-index-list"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 rounded-lg border border-border bg-white px-3 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
      >
        <ChevronRightIcon aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        {t("prepare.indexTitle", { n: entries.length })}
      </button>
      <p className="mb-1.5 hidden text-xs font-semibold tracking-wide text-muted-foreground uppercase lg:block">{t("prepare.indexTitle", { n: entries.length })}</p>
      <ol id="clip-index-list" className={cn("mt-1 grid gap-1 lg:mt-0 lg:grid", open ? "grid" : "hidden")}>
        {entries.map((e) => (
          <li key={e.id}>
            <a
              href={`#clip-${e.id}`}
              className="grid gap-0.5 rounded-lg border border-border bg-white px-2.5 py-1.5 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="font-mono text-xs">
                  {t("prepare.clipHeading", { n: e.n })} · {formatTimestamp(e.startMs)}
                </span>
                <ClipStatusBadge status={e.status} dismissed={e.dismissed} />
              </span>
              {e.title && (
                <span lang={language} dir="auto" className="truncate text-xs text-muted-foreground">
                  {e.title}
                </span>
              )}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
