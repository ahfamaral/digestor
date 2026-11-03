"use client";

import type { ChecklistId, Range } from "@digestor/core";
import { Check, Circle } from "lucide-react";
import { NamePopover } from "@/components/Names/NamePopover";
import type { NamesData, UnconfirmedVoice } from "@/lib/names";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export interface ChecklistProps {
  clipId: string;
  /** `exportChecklist` items; `protected` is present for the trial profile only. */
  items: { id: ChecklistId; ok: boolean }[];
  protectedAck: boolean;
  /** Voices of the clip whose name is not confirmed; they say who is missing in the `speaker` item. */
  unconfirmed: UnconfirmedVoice[];
  names: NamesData;
  sessionId: string;
  range: Range;
  language?: string;
  /** The video was removed: names can't be changed from here. */
  frozen?: boolean;
  busy: boolean;
  onProtected: (ack: boolean) => void;
}

/** The pre-export checklist of one clip (spec §9.4). The trial item is the acknowledgement itself. */
export function Checklist({ clipId, items, unconfirmed, names, sessionId, range, language, frozen, protectedAck, busy, onProtected }: ChecklistProps) {
  return (
    <section aria-labelledby={`checklist-h-${clipId}`}>
      <h3 id={`checklist-h-${clipId}`} className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("prepare.checklist")}
      </h3>
      <ul className="grid gap-1">
        {items.map((item) =>
          item.id === "protected" ? (
            <li key={item.id}>
              <label className="flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[13px] font-medium text-violet-950">
                <Checkbox checked={protectedAck} disabled={busy} onCheckedChange={(v) => onProtected(v === true)} className="mt-0.5" />
                <span>{t("prepare.item.protected")}</span>
              </label>
            </li>
          ) : (
            <li key={item.id} className={cn("flex items-start gap-2 text-[13px]", item.ok ? "text-foreground" : "text-muted-foreground")}>
              {item.ok ? (
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-green-700" />
              ) : (
                <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-stone-400" />
              )}
              <span>
                {t(`prepare.item.${item.id}`)}
                <span className="sr-only">: {item.ok ? t("prepare.itemOk") : t("prepare.itemTodo")}</span>
                {item.id === "speaker" && !item.ok && (
                  <ul className="mt-1 grid gap-1">
                    {unconfirmed.map((v) => (
                      <li key={`${v.speakerId}:${v.atMs}`} className="flex flex-wrap items-center gap-2 text-foreground">
                        <span lang={v.label.badge ? language : undefined} dir="auto">
                          {t("prepare.speakerNotConfirmed", { label: v.label.text })}
                        </span>
                        <NamePopover
                          sessionId={sessionId}
                          speakerId={v.speakerId}
                          label={v.label}
                          names={names}
                          range={v.range ?? range}
                          ranges={v.ranges}
                          rangeOnly={v.range !== null}
                          confirmBody={v.confirm ?? undefined}
                          offerNoName
                          trigger={
                            <button
                              type="button"
                              disabled={busy || frozen}
                              className="inline-flex h-7 items-center rounded-md border border-border bg-white px-2 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                            >
                              {t("prepare.confirmNames")}
                            </button>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </span>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
