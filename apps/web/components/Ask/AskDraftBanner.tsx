"use client";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** Phone only: Ask has worked on the session's goal; this offers to open it and never opens the sheet itself. */
export function AskDraftBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-white px-3 py-2 text-sm">
      <span>{t("ask.draftBanner")}</span>
      <Button type="button" size="sm" variant="outline" onClick={onOpen}>
        {t("ask.draftOpen")}
      </Button>
    </div>
  );
}
