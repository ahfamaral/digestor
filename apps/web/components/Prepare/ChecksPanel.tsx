"use client";

import type { MomentChecks } from "@digestor/core";
import { Checkbox } from "@/components/ui/checkbox";
import { checkWarnings } from "@/lib/prepareData";
import { t } from "@/lib/i18n";

export interface ChecksPanelProps {
  clipId: string;
  title: string;
  /** The session's spoken language (the next sentence is quoted in it). */
  language: string | undefined;
  checks: MomentChecks | null;
  /** Checks were still null after a minute: they couldn't run. */
  timedOut: boolean;
  warningsAck: boolean;
  busy: boolean;
  onAck: (ack: boolean) => void;
  onExtend: () => void;
}

const ROW = "rounded-lg border px-2.5 py-1.5 text-[13px]";

/** The AI checks of a clip's moment (Ruling R11: "Checking…", then "couldn't run" after a minute) and the one acknowledgement. */
export function ChecksPanel({ clipId, title, language, checks, timedOut, warningsAck, busy, onAck, onExtend }: ChecksPanelProps) {
  const warnings = checks ? checkWarnings(checks) : [];
  const failed = checks === null && timedOut;
  const showAck = warnings.length > 0 || failed || warningsAck;

  return (
    <section aria-labelledby={`checks-h-${clipId}`}>
      <h3 id={`checks-h-${clipId}`} className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("prepare.checks")}
      </h3>
      <div role="status" className="grid gap-1.5">
        {checks === null && !timedOut && <p className="text-[13px] text-muted-foreground">{t("prepare.checking")}</p>}
        {failed && <p className={`${ROW} border-amber-300 bg-amber-50 text-amber-900`}>{t("prepare.checksFailed")}</p>}
        {checks !== null && warnings.length === 0 && <p className="text-[13px] text-muted-foreground">{t("prepare.noWarnings")}</p>}
      </div>
      {warnings.length > 0 && (
        <ul className="grid gap-1.5">
          {warnings.map((w) => (
            <li key={w.kind} className={`${ROW} border-amber-300 bg-amber-50 text-amber-950`}>
              {w.kind === "argument" && (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">{t("prepare.argumentContinues")}</p>
                    {w.detail && (
                      <p className="mt-0.5 text-xs text-amber-900">
                        {t("prepare.continuesWith")}{" "}
                        <span lang={language} dir="auto" className="italic">
                          “{w.detail}”
                        </span>
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={onExtend}
                    disabled={busy}
                    aria-label={t("prepare.extendLabel", { title })}
                    className="inline-flex h-7 shrink-0 items-center rounded-md border border-amber-400 bg-white px-2 text-xs font-semibold text-amber-950 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
                  >
                    {t("prepare.extend")}
                  </button>
                </div>
              )}
              {w.kind === "context" && (
                <p dir="auto">
                  {t("prepare.context", { text: w.detail ?? "" })}
                </p>
              )}
              {w.kind === "reportedSpeech" && <p className="font-semibold">{t("prepare.reportedSpeech")}</p>}
              {w.kind === "interpreter" && <p className="font-semibold">{t("prepare.interpreter")}</p>}
            </li>
          ))}
        </ul>
      )}
      {showAck && (
        <label className="mt-2 flex items-start gap-2 text-[13px] font-medium">
          <Checkbox checked={warningsAck} disabled={busy} onCheckedChange={(v) => onAck(v === true)} className="mt-0.5" />
          <span>{t("prepare.warningsAck")}</span>
        </label>
      )}
    </section>
  );
}
