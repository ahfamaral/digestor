import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** A small text tag on clips Ask created (text, not colour only). */
export function MadeWithAsk({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border border-border bg-stone-50 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-stone-700", className)}>
      {t("prepare.madeWithAsk")}
    </span>
  );
}
