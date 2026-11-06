"use client";

import { useState } from "react";
import Link from "next/link";
import { formatLength, type ClipFormat } from "@digestor/core";
import { t } from "@/lib/i18n";

/** A clip as a row's strip shows it (built on the server from `listClipPreviews`). */
export interface ClipTile {
  id: string;
  startMs: number;
  endMs: number;
  format: ClipFormat;
  merged: boolean;
  rendered: boolean;
  thumbUrl: string | null;
  languages: string[];
}

const SHOWN = 4;
const TILE = "flex w-32 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-white text-xs";

/** Up to four clip tiles, then a "+ N more" square that shows the rest in place. */
export function ClipStrip({ sessionId, clips }: { sessionId: string; clips: ClipTile[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? clips : clips.slice(0, SHOWN);
  const rest = clips.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-2 py-1">
      {shown.map((c, i) => (
        <li key={c.id}>
          <Link
            href={`/s/${sessionId}/prepare`}
            className={`${TILE} outline-none hover:border-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring`}
          >
            <span className="relative flex h-16 items-center justify-center bg-[#2a2b31]">
              {c.thumbUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- a small thumbnail from our own files route
                <img
                  src={c.thumbUrl}
                  alt=""
                  loading="lazy"
                  className={c.format === "9:16" ? "h-full w-auto object-cover" : "h-full w-full object-cover"}
                  style={c.format === "9:16" ? { aspectRatio: "9 / 16" } : undefined}
                />
              )}
              <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 font-mono text-[10px] text-white">
                {formatLength(c.endMs - c.startMs)}
              </span>
            </span>
            <span className="flex flex-col gap-0.5 px-2 py-1.5">
              <span>
                <span className="font-semibold">{t("home.clipTile", { n: i + 1 })}</span>
                {" · "}
                {c.merged ? t("home.merged") : c.format}
              </span>
              <span className={c.rendered ? "text-emerald-700" : "text-muted-foreground"}>
                {c.rendered ? t("home.rendered") : t("home.notRendered")}
              </span>
              {c.languages.length > 0 && (
                <span className="text-muted-foreground">{t("home.subtitles", { langs: c.languages.join(", ") })}</span>
              )}
            </span>
          </Link>
        </li>
      ))}
      {rest > 0 && (
        <li>
          <button
            type="button"
            onClick={() => setAll(true)}
            className={`${TILE} h-full min-h-28 items-center justify-center text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring`}
          >
            {t("home.moreClips", { n: rest })}
          </button>
        </li>
      )}
    </ul>
  );
}
