import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export const STEPS = ["Upload", "Processing", "Context", "Briefing", "Prepare", "Export"] as const;
export type Step = (typeof STEPS)[number];

/** Top bar: "Digestor." logo and the six-step indicator (done steps green with ✓, current step bold). */
export function AppBar({ current, children }: { current?: Step; children?: React.ReactNode }) {
  const at = current ? STEPS.indexOf(current) : -1;
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border bg-white px-4 py-3">
      <div className="text-base font-extrabold tracking-tight">
        {t("app.name")}<span className="text-brand">.</span>
      </div>
      {current && (
        <nav aria-label={t("appBar.progress")} className="hidden items-center gap-1.5 text-xs text-[#a3a29c] sm:flex">
          {STEPS.map((step, i) => (
            <span key={step} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden>›</span>}
              <span
                aria-current={i === at ? "step" : undefined}
                className={cn(i < at && "text-emerald-600", i === at && "font-bold text-foreground")}
              >
                {t(`appBar.step.${step}`)}
                {i < at && " ✓"}
              </span>
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
