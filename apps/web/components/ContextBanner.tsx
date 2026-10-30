"use client";

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { type ContextCard } from "@digestor/core";
import { t } from "@/lib/i18n";

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const bannerKey = (sessionId: string) => `digestor:banner:${sessionId}`;

/** One-line summary of the context card above the briefing: profile · language · date · setting · title. Dismissible; the choice is remembered per session in this browser. */
export function ContextBanner({ sessionId, card }: { sessionId: string; card: ContextCard }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(bannerKey(sessionId)) === "1") setDismissed(true);
    } catch {
      // storage unavailable: the banner just shows
    }
  }, [sessionId]);
  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(bannerKey(sessionId), "1");
    } catch {
      // not remembered, still hidden for this view
    }
  }
  if (dismissed) return null;

  const parts = [
    t(`profile.${card.profile.value}`),
    card.language.value && languageName(card.language.value),
    card.dateOrYear.value,
    card.setting.value,
    card.title.value,
  ].filter((p): p is string => Boolean(p?.trim()));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-sm">
      <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800">{t("context.bannerLabel")}</span>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
          <span>{p}</span>
        </span>
      ))}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("context.bannerDismiss")}
        className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted"
      >
        <XIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
