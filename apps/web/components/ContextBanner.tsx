"use client";

import { useState, useSyncExternalStore } from "react";
import { XIcon } from "lucide-react";
import { type ContextCard } from "@digestor/core";
import { browserStorage, readBannerDismissed, writeBannerDismissed } from "@/lib/bannerDismiss";
import { languageName, t } from "@/lib/i18n";

function subscribeStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** One-line summary of the context card above the briefing: profile · language · date · setting · title. Dismissible; the choice is remembered per session in this browser. */
export function ContextBanner({ sessionId, card }: { sessionId: string; card: ContextCard }) {
  // null on the server and before hydration, so a dismissed banner never flashes in.
  const stored = useSyncExternalStore(subscribeStorage, () => readBannerDismissed(browserStorage(), sessionId), () => null);
  const [hidden, setHidden] = useState(false);
  function dismiss() {
    setHidden(true);
    writeBannerDismissed(browserStorage(), sessionId); // if not stored, it is still hidden for this view
  }
  if (stored !== false || hidden) return null;

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
