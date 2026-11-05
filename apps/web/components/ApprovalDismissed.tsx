import { TriangleAlertIcon } from "lucide-react";
import { t } from "@/lib/i18n";

/** Neutral label for a clip whose moment is no longer approved; the hint is a tooltip and read out via aria-describedby. */
export function ApprovalDismissed({ id }: { id: string }) {
  return (
    <>
      <span
        title={t("prepare.approvalDismissedHint")}
        aria-describedby={id}
        className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 align-middle text-xs font-medium text-stone-900"
      >
        <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-stone-700" />
        {t("prepare.approvalDismissed")}
      </span>
      <span id={id} className="sr-only">
        {t("prepare.approvalDismissedHint")}
      </span>
    </>
  );
}
