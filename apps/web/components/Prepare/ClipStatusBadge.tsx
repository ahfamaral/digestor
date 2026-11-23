import { Check } from "lucide-react";
import type { ClipStatus } from "@/lib/prepareData";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * "Ready to export" / "N to do" (from the export checklist); a clip whose approval was dismissed says it is left out.
 * `checklistHref`: "N to do" links to the clip's "Before export" list, so the count leads to what is left.
 */
export function ClipStatusBadge({ status, dismissed, className, checklistHref }: { status: ClipStatus; dismissed: boolean; className?: string; checklistHref?: string }) {
  const ready = status.ready && !dismissed;
  const text = dismissed ? t("prepare.statusLeftOut") : status.ready ? t("prepare.statusReady") : t("prepare.statusTodo", { n: status.todo });
  const cls = cn(
    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
    ready ? "bg-green-100 text-green-800" : "bg-stone-200 text-stone-800",
    className,
  );
  if (checklistHref && !status.ready && !dismissed) {
    return (
      <a href={checklistHref} aria-label={t("prepare.statusTodoLink", { n: status.todo })} className={cn(cls, "min-h-6 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1")}>
        {text}
      </a>
    );
  }
  return (
    <span className={cls}>
      {ready && <Check aria-hidden className="size-3" />}
      {text}
    </span>
  );
}
