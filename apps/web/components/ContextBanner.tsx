"use client";

import { useState, useSyncExternalStore } from "react";
import { type ContextCard } from "@digestor/core";
import { browserStorage, readBannerDismissed, writeBannerDismissed } from "@/lib/bannerDismiss";
import { t } from "@/lib/i18n";

function subscribeStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * The context card's extra details (date, setting, title) as spans at the end of the Briefing's header meta line ("·" between
 * them; the span before them ends in one), with a small "Hide" text button after them (profile and language are already in that line). Remembered per session in this browser.
 */
export function ContextBanner({ sessionId, card, sessionTitle, language }: { sessionId: string; card: ContextCard; sessionTitle: string; language?: string }) {
  // null on the server and before hydration, so a dismissed banner never flashes in.
  const stored = useSyncExternalStore(subscribeStorage, () => readBannerDismissed(browserStorage(), sessionId), () => null);
  const [hidden, setHidden] = useState(false);
  function dismiss() {
    setHidden(true);
    writeBannerDismissed(browserStorage(), sessionId); // if not stored, it is still hidden for this view
  }
  if (stored !== false || hidden) return null;

  const parts = [
    { text: card.dateOrYear.value, spoken: false },
    { text: card.setting.value, spoken: true },
    { text: card.title.value !== sessionTitle ? card.title.value : null, spoken: true },
  ].filter((p): p is { text: string; spoken: boolean } => Boolean(p.text?.trim()));
  if (parts.length === 0) return null;

  return (
    <>
      {parts.map((p, i) => (
        <span key={i} lang={p.spoken ? language : undefined} dir={p.spoken ? "auto" : undefined} className={i < parts.length - 1 ? "after:ml-1.5 after:content-['·']" : undefined}>
          {p.text}
        </span>
      ))}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("context.bannerDismiss")}
        title={t("context.bannerDismiss")}
        className="rounded-sm px-0.5 font-sans text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
      >
        {t("context.bannerHide")}
      </button>
    </>
  );
}
