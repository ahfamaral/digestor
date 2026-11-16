import Link from "next/link";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { stepHref, stepShownDone, type StepFacts } from "@/lib/stepLinks";

export const STEPS = ["Upload", "Processing", "Context", "Briefing", "Prepare", "Export"] as const;
export type Step = (typeof STEPS)[number];

/** The bar's link texts and their language, when not Digestor's English. */
export type AppBarLabels = { sessions: string; monitor: string; skip: string; lang?: string };

const FOCUS = "rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/**
 * `signedOut` (the login page) leaves out the Sessions link: there is nowhere to go before signing in. `area` marks the
 * current top link (`aria-current`); `skipTo` adds a "Skip to content" link to that element id, shown on focus.
 * Top bar: "Digestor." logo, a "Sessions" link home, and the six-step indicator (done steps green with ✓, current step
 * bold). Inside a ready session (`session.ready`) Briefing, Prepare and Export are links to jump between them.
 * `labels`: the bar's link texts in another language (the monitor's pages in Portuguese, `MonitorAppBar`); the
 * journalist pages leave it out and stay English.
 */
export function AppBar({ current, session, facts = { hasClips: false, allReadyRendered: false }, signedOut = false, area, skipTo, labels, children }: { current?: Step; signedOut?: boolean; session?: { id: string; ready: boolean }; facts?: StepFacts; area?: "sessions" | "monitor"; skipTo?: string; labels?: AppBarLabels; children?: React.ReactNode }) {
  const at = current ? STEPS.indexOf(current) : -1;
  const text = labels ?? { sessions: t("appBar.sessions"), monitor: t("appBar.monitor"), skip: t("appBar.skip") };
  return (
    <header lang={labels?.lang} className="flex items-center justify-between gap-4 border-b border-border bg-white px-4 py-3">
      <div className="flex items-center gap-4">
        {skipTo && (
          <a
            href={`#${skipTo}`}
            className="sr-only rounded bg-white px-2 py-1 text-sm font-medium focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus-visible:ring-2 focus-visible:ring-brand"
          >
            {text.skip}
          </a>
        )}
        <Link href="/" className={cn("inline-flex h-8 items-center text-base font-extrabold tracking-tight", FOCUS)}>
          {t("app.name")}<span className="text-brand">.</span>
        </Link>
        {!signedOut && <Link href="/" className={cn("inline-flex h-8 items-center px-1 text-sm font-medium text-muted-foreground hover:text-foreground", FOCUS)}>
          {text.sessions}
        </Link>}
        {!signedOut && <Link href="/monitor" aria-current={area === "monitor" ? "page" : undefined} className={cn("inline-flex h-8 items-center px-1 text-sm font-medium text-muted-foreground hover:text-foreground", area === "monitor" && "text-foreground", FOCUS)}>
          {text.monitor}
        </Link>}
      </div>
      {current && (
        <nav aria-label={t("appBar.progress")} className="hidden items-center gap-1.5 text-xs text-step-upcoming sm:flex">
          {STEPS.map((step, i) => {
            const href = session && i !== at ? stepHref(step, session) : null;
            const done = stepShownDone(step, i, at, facts);
            const label = (
              <>
                {t(`appBar.step.${step}`)}
                {done && " ✓"}
              </>
            );
            const tone = cn((i < at || done) && "text-step-done", i === at && "font-bold text-foreground");
            return (
              <span key={step} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden>›</span>}
                {href ? (
                  <Link href={href} className={cn(tone, i > at && "text-foreground/70", "underline-offset-2 hover:underline", FOCUS)}>
                    {label}
                  </Link>
                ) : (
                  <span aria-current={i === at ? "step" : undefined} className={tone}>
                    {label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
      )}
      {current && (
        <p className="text-xs font-medium text-step-upcoming sm:hidden">
          {t("appBar.stepOf", { n: at + 1, total: STEPS.length, name: t(`appBar.step.${current}`) })}
        </p>
      )}
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
