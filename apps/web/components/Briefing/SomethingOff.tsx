"use client";

import { useState } from "react";
import Link from "next/link";
import { PROFILES, estimateReanalysisUsd, type ProfileId } from "@digestor/core";
import { aboutUsd } from "@/lib/cost";
import { ReportProblem, type Target } from "@/components/ReportProblem";
import { Dropdown } from "@/components/Dropdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Busy } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/http";
import { t } from "@/lib/i18n";

/**
 * "Something's off": opens two choices, "Back to context check" (re-run the analysis with a profile) and "Report a
 * problem". The re-analysis dialog's open state is the page's, so the names-changed notice can open it too.
 */
export function SomethingOff({
  sessionId,
  durationMs,
  profile,
  targets,
  reanalyzeOpen,
  onReanalyzeOpenChange,
  onStarted,
}: {
  sessionId: string;
  /** The video's length: the re-analysis estimate. */
  durationMs: number;
  profile: ProfileId;
  targets: Target[];
  reanalyzeOpen: boolean;
  onReanalyzeOpenChange: (open: boolean) => void;
  onStarted: () => void;
}) {
  const [offOpen, setOffOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="outline" size="sm" aria-expanded={offOpen} aria-controls="something-off" onClick={() => setOffOpen((o) => !o)}>
        {t("preview.somethingOff")}
      </Button>
      {offOpen && (
        <div id="something-off" className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onReanalyzeOpenChange(true)}>
            {t("preview.backToContext")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
            {t("preview.reportProblem")}
          </Button>
        </div>
      )}
      {reportSent && (
        <p role="status" className="text-right text-xs text-emerald-700">
          {t("preview.reportSent")}{" "}
          <Link href="/reports" className="underline underline-offset-2">
            {t("preview.reportsLink")}
          </Link>
        </p>
      )}
      <ReanalyzeDialog
        open={reanalyzeOpen}
        onOpenChange={onReanalyzeOpenChange}
        sessionId={sessionId}
        durationMs={durationMs}
        current={profile}
        onStarted={() => {
          setOffOpen(false);
          onStarted();
        }}
      />
      <ReportProblem
        open={reportOpen}
        onOpenChange={setReportOpen}
        sessionId={sessionId}
        targets={targets}
        onSent={() => {
          setOffOpen(false);
          setReportSent(true);
        }}
      />
    </div>
  );
}

/** "Back to context check": choose the profile and confirm a new AI pass (POST reanalyze), with its estimated cost (analysis only). */
function ReanalyzeDialog({
  open,
  onOpenChange,
  sessionId,
  durationMs,
  current,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  durationMs: number;
  current: ProfileId;
  onStarted: () => void;
}) {
  const [profile, setProfile] = useState<ProfileId>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, t("preview.errorGeneric")));
      close();
      onStarted();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("preview.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setProfile(current);
    setError(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={confirm} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>{t("preview.backToContext")}</DialogTitle>
            <DialogDescription>
              {t("preview.reanalyzeBody")}
              {durationMs > 0 && (
                <span className="mt-2 block font-medium text-foreground">{t("cost.reanalyze", { cost: aboutUsd(estimateReanalysisUsd(durationMs)) })}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {t("preview.reanalyzeProfile")}
            <Dropdown
              value={profile}
              onValueChange={setProfile}
              options={(Object.keys(PROFILES) as ProfileId[]).map((id) => ({ value: id, label: t(`profile.${id}`) }))}
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("preview.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              <Busy busy={busy}>{busy ? t("preview.reanalyzeBusy") : t("preview.reanalyzeConfirm")}</Busy>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
