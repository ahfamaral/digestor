"use client";

import type { ChecklistId } from "@digestor/core";
import { Check, Circle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export interface ChecklistProps {
  clipId: string;
  /** `exportChecklist` items; `protected` is present for the trial profile only. */
  items: { id: ChecklistId; ok: boolean }[];
  protectedAck: boolean;
  busy: boolean;
  onProtected: (ack: boolean) => void;
}

/** The pre-export checklist of one clip (spec §9.4). The trial item is the acknowledgement itself. */
export function Checklist({ clipId, items, protectedAck, busy, onProtected }: ChecklistProps) {
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
              </span>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
