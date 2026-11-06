"use client";

import { useRef, useState } from "react";
import { WarningIcon, WARNING_BOX } from "@/components/WarningNote";
import { WhosWhoDrawer } from "@/components/Names/WhosWho";
import { unconfirmedBannerText, type NamesData, type WhosWhoRow } from "@/lib/names";
import { t } from "@/lib/i18n";

/**
 * One banner for the whole session on Prepare and Export: how many voices are still unconfirmed and how many clips they
 * block, with "Confirm names" opening Who's who. The page refreshes after each answer, so the banner follows by itself.
 */
export function UnconfirmedBanner({
  sessionId,
  unconfirmed,
  rows,
  names,
  sensitive,
  profile,
  language,
  videoRemoved,
}: {
  sessionId: string;
  unconfirmed: { voices: number; clips: number };
  rows: WhosWhoRow[];
  names: NamesData;
  sensitive: boolean;
  profile?: string;
  language?: string;
  videoRemoved: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      {unconfirmed.voices > 0 && (
        <div role="status" className={`mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 text-sm ${WARNING_BOX}`}>
          <WarningIcon className="shrink-0" />
          <span className="min-w-0 flex-1">{unconfirmedBannerText(unconfirmed)}</span>
          <button
            ref={button}
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex h-8 items-center rounded-md border border-border bg-white px-3 text-xs font-semibold text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
          >
            {t("prepare.confirmNames")}
          </button>
        </div>
      )}
      <WhosWhoDrawer
        open={open}
        onOpenChange={setOpen}
        finalFocus={button}
        sessionId={sessionId}
        rows={rows}
        names={names}
        sensitive={sensitive}
        profile={profile}
        language={language}
        videoRemoved={videoRemoved}
      />
    </>
  );
}
