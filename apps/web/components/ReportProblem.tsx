"use client";

import { useState } from "react";
import type { MomentWithHighlights, ProblemTargetKind } from "@digestor/core";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/http";
import { topicIdOf, type PreviewSection } from "@/lib/preview";
import { t } from "@/lib/i18n";
import { Dropdown } from "@/components/Dropdown";
import { Busy } from "@/components/ui/spinner";

export type Target = { kind: ProblemTargetKind; id: string; label: string };

/** What a Briefing report can point at: the briefing, a topic, its key quote or one of its moments (time order). */
export function previewTargets(analysisId: string, sections: PreviewSection[], moments: MomentWithHighlights[]): Target[] {
  const out: Target[] = [{ kind: "briefing", id: analysisId, label: t("preview.targetBriefing") }];
  const topics = sections.map((s) => s.topic);
  const byTopic = new Map<string, MomentWithHighlights[]>();
  for (const m of [...moments].sort((a, b) => a.startMs - b.startMs)) {
    const id = topicIdOf(m, topics);
    if (id) byTopic.set(id, [...(byTopic.get(id) ?? []), m]);
  }
  for (const s of sections) {
    out.push({ kind: "topic", id: s.topic.id, label: t("preview.targetTopic", { n: s.n, title: s.topic.title }) });
    if (s.keyQuote) out.push({ kind: "quote", id: s.keyQuote.momentId, label: t("preview.targetQuote", { n: s.n }) });
    for (const m of byTopic.get(s.topic.id) ?? []) out.push({ kind: "moment", id: m.id, label: t("preview.targetMoment", { title: m.title }) });
  }
  return out;
}

const FIELD = "w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand";

/** "Report a problem": pick what is wrong, add an optional note, POST /api/reports. */
export function ReportProblem({
  open,
  onOpenChange,
  sessionId,
  targets,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  targets: Target[];
  onSent: () => void;
}) {
  const [target, setTarget] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setError(null);
    onOpenChange(false);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const chosen = targets[target];
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, targetKind: chosen.kind, targetId: chosen.id, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, t("preview.errorGeneric")));
      setNote("");
      setTarget(0);
      close();
      onSent();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("preview.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={send} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>{t("preview.reportProblem")}</DialogTitle>
            <DialogDescription className="sr-only">{t("preview.reportTarget")}</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {t("preview.reportTarget")}
            <Dropdown
              value={String(target)}
              onValueChange={(v) => setTarget(Number(v))}
              options={targets.map((tg, i) => ({ value: String(i), label: tg.label }))}
              className="mt-0"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {t("preview.reportNote")}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={t("preview.reportNotePlaceholder")}
              className={FIELD}
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
            <Button type="submit" disabled={busy || targets.length === 0}>
              <Busy busy={busy}>{busy ? t("preview.reportBusy") : t("preview.reportSend")}</Busy>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
