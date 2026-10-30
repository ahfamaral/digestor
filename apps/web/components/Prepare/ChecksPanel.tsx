"use client";

import type { MomentChecks } from "@digestor/core";
import { Checkbox } from "@/components/ui/checkbox";
import { WarningNote } from "@/components/WarningNote";
import { checkWarnings, checksStatus } from "@/lib/prepareData";
import { t } from "@/lib/i18n";

export interface ChecksPanelProps {
  clipId: string;
  title: string;
  /** The session's spoken language (the next sentence is quoted in it). */
  language: string | undefined;
  /** The moment's checks when they belong to this cut; null otherwise. */
  checks: MomentChecks | null;
  /** Checks exist, but for the moment's bounds: the clip was trimmed since (R28). */
  originalCut: boolean;
  /** Checks were still null after a minute: they couldn't run. */
  timedOut: boolean;
  warningsAck: boolean;
  busy: boolean;
  /** The video was removed (R30): Extend changes the bounds, so it is off; the acknowledgement still works. */
  frozen: boolean;
  /** "Check again" is sending. */
  checkingAgain: boolean;
  onAck: (ack: boolean) => void;
  onExtend: () => void;
  onCheckAgain: () => void;
}

const ACT =
  "inline-flex h-7 shrink-0 items-center rounded-md border border-stone-300 bg-white px-2 text-xs font-semibold text-foreground outline-none hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The AI checks of a clip's moment and the one acknowledgement. "Checking…", then "couldn't run" after a minute with
 * "Check again" (R11, R29); checks made for the original cut don't count once the clip is trimmed (R28).
 */
export function ChecksPanel({
  clipId, title, language, checks, originalCut, timedOut, warningsAck, busy, frozen, checkingAgain, onAck, onExtend, onCheckAgain,
}: ChecksPanelProps) {
  const status = checksStatus({ checks, originalCut, timedOut });
  const warnings = checks ? checkWarnings(checks) : [];
  const showAck = warnings.length > 0 || status === "failed" || status === "originalCut" || warningsAck;

  return (
    <section aria-labelledby={`checks-h-${clipId}`}>
      <h3 id={`checks-h-${clipId}`} className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("prepare.checks")}
      </h3>
      <div role="status" className="grid gap-1.5">
        {status === "checking" && <p className="text-[13px] text-muted-foreground">{t("prepare.checking")}</p>}
        {status === "failed" && (
          <WarningNote>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>{t("prepare.checksFailed")}</p>
              <button
                type="button"
                onClick={onCheckAgain}
                disabled={checkingAgain}
                aria-label={t("prepare.checkAgainLabel", { title })}
                className={ACT}
              >
                {t("prepare.checkAgain")}
              </button>
            </div>
          </WarningNote>
        )}
        {status === "originalCut" && (
          <WarningNote>
            <p>{t("prepare.checksOriginalCut")}</p>
          </WarningNote>
        )}
        {status === "checked" && warnings.length === 0 && <p className="text-[13px] text-muted-foreground">{t("prepare.noWarnings")}</p>}
      </div>
      {warnings.length > 0 && (
        <ul className="grid gap-1.5">
          {warnings.map((w) => (
            <li key={w.kind}>
              <WarningNote>
                {w.kind === "argument" && (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{t("prepare.argumentContinues")}</p>
                      {w.detail && (
                        <p className="mt-0.5 text-xs text-stone-700">
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
                      disabled={busy || frozen}
                      aria-label={t("prepare.extendLabel", { title })}
                      aria-describedby={frozen ? "video-removed" : undefined}
                      className={ACT}
                    >
                      {t("prepare.extend")}
                    </button>
                  </div>
                )}
                {w.kind === "context" && <p dir="auto">{t("prepare.context", { text: w.detail ?? "" })}</p>}
                {w.kind === "reportedSpeech" && <p className="font-semibold">{t("prepare.reportedSpeech")}</p>}
                {w.kind === "interpreter" && <p className="font-semibold">{t("prepare.interpreter")}</p>}
              </WarningNote>
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
