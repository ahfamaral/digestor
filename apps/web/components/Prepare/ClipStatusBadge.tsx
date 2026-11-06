import { Check } from "lucide-react";
import type { ClipStatus } from "@/lib/prepareData";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** "Ready to export" / "N to do" (from the export checklist); a clip whose approval was dismissed says it is left out. */
export function ClipStatusBadge({ status, dismissed, className }: { status: ClipStatus; dismissed: boolean; className?: string }) {
  const ready = status.ready && !dismissed;
  const text = dismissed ? t("prepare.statusLeftOut") : status.ready ? t("prepare.statusReady") : t("prepare.statusTodo", { n: status.todo });
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        ready ? "bg-green-100 text-green-800" : "bg-stone-200 text-stone-800",
        className,
      )}
    >
      {ready && <Check aria-hidden className="size-3" />}
      {text}
    </span>
  );
}
