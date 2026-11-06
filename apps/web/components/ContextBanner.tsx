"use client";

import { useState, useSyncExternalStore } from "react";
import { XIcon } from "lucide-react";
import { type ContextCard } from "@digestor/core";
import { browserStorage, readBannerDismissed, writeBannerDismissed } from "@/lib/bannerDismiss";
import { t } from "@/lib/i18n";

function subscribeStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * The context card's extra details (date, setting, title) as spans inside the Briefing's header meta line, with a small
 * dismiss button after them (profile and language are already in that line). Remembered per session in this browser.
 */
export function ContextBanner({ sessionId, card, sessionTitle }: { sessionId: string; card: ContextCard; sessionTitle: string }) {
  // null on the server and before hydration, so a dismissed banner never flashes in.
  const stored = useSyncExternalStore(subscribeStorage, () => readBannerDismissed(browserStorage(), sessionId), () => null);
  const [hidden, setHidden] = useState(false);
  function dismiss() {
    setHidden(true);
    writeBannerDismissed(browserStorage(), sessionId); // if not stored, it is still hidden for this view
  }
  if (stored !== false || hidden) return null;

  const parts = [card.dateOrYear.value, card.setting.value, card.title.value !== sessionTitle ? card.title.value : null].filter(
    (p): p is string => Boolean(p?.trim()),
  );
  if (parts.length === 0) return null;

  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="after:ml-1.5 after:content-['·']">
          {p}
        </span>
      ))}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("context.bannerDismiss")}
        title={t("context.bannerDismiss")}
        className="-ml-1 mr-1 grid size-5 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
      >
        <XIcon className="size-3.5" aria-hidden />
      </button>
    </>
  );
}
