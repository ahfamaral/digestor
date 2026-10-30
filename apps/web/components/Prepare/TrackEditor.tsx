"use client";

import { useState } from "react";
import { formatTimestamp } from "@digestor/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { patchTrack } from "@/lib/prepareApi";
import type { TrackView } from "@/lib/prepareData";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export interface TrackEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  track: TrackView;
  /** e.g. "German" or "Portuguese (original)". */
  languageLabel: string;
  /** The video's spoken language (the originals are in it). */
  originalLanguage: string | undefined;
  onSaved: (track: TrackView) => void;
}

/**
 * Review one language's subtitle lines next to the original: edit any line, then approve. Missing lines are marked
 * "Missing translation" and block approval (the server refuses too). Mount it with `key={track.id}` per opening.
 */
export function TrackEditor({ open, onOpenChange, track, languageLabel, originalLanguage, onSaved }: TrackEditorProps) {
  const [texts, setTexts] = useState(() => track.cues.map((c) => c.text));
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const changed = texts.flatMap((text, i) => (text !== track.cues[i]?.text ? [{ i, text }] : []));
  const missing = texts.filter((x) => x.trim() === "").length;
  const canApprove = missing === 0 && texts.length > 0 && (!track.approved || changed.length > 0);

  async function save(): Promise<TrackView | null> {
    if (changed.length === 0) return track;
    const updated = await patchTrack(track.id, { edits: changed });
    onSaved(updated);
    return updated;
  }

  async function run(kind: "save" | "approve") {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await save();
      if (kind === "approve") {
        onSaved(await patchTrack(track.id, { approve: true }));
        onOpenChange(false);
      } else {
        setNotice(t("prepare.linesSaved"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("prepare.editorTitle", { language: languageLabel })}</DialogTitle>
          <DialogDescription>{t("prepare.editorDescription")}</DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto border-y border-border px-4 py-2">
          <div aria-hidden className="mb-1 hidden grid-cols-2 gap-3 text-xs font-semibold text-muted-foreground sm:grid">
            <span>{t("prepare.colOriginal")}</span>
            <span>{t("prepare.colSubtitle")}</span>
          </div>
          <ol className="grid gap-2">
            {track.cues.map((cue, i) => {
              const empty = (texts[i] ?? "").trim() === "";
              const id = `cue-${track.id}-${i}`;
              return (
                <li key={i} className="grid gap-1 sm:grid-cols-2 sm:gap-3">
                  <div className="text-[13px]">
                    <span className="font-mono text-[10px] text-muted-foreground">{formatTimestamp(cue.startMs, { tenths: true })}</span>
                    <p lang={originalLanguage} dir="auto" className="text-foreground/90">
                      <span className="sr-only">{t("prepare.colOriginal")}: </span>
                      {cue.original}
                    </p>
                  </div>
                  <div>
                    <label htmlFor={id} className="sr-only">
                      {t("prepare.lineLabel", { n: i + 1, time: formatTimestamp(cue.startMs, { tenths: true }) })}
                    </label>
                    <textarea
                      id={id}
                      lang={track.language}
                      dir="auto"
                      rows={2}
                      value={texts[i] ?? ""}
                      disabled={busy !== null}
                      aria-invalid={empty || undefined}
                      aria-describedby={empty ? `${id}-missing` : undefined}
                      onChange={(e) => setTexts((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                      className={cn(
                        "w-full resize-y rounded-md border bg-white px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand",
                        empty ? "border-red-400 bg-red-50" : "border-border",
                      )}
                    />
                    {empty && (
                      <p id={`${id}-missing`} className="text-xs font-medium text-red-700">
                        {t("prepare.missing")}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="grid gap-1 text-xs">
          {missing > 0 && <p className="text-red-700">{missing === 1 ? t("prepare.missingOne") : t("prepare.missingMany", { n: missing })}</p>}
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          <p role="status" className="text-muted-foreground">
            {notice}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("prepare.close")}
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || changed.length === 0} onClick={() => void run("save")}>
            {busy === "save" ? t("prepare.saving") : t("prepare.saveLines")}
          </Button>
          <Button type="button" disabled={busy !== null || !canApprove} onClick={() => void run("approve")}>
            {busy === "approve" ? t("prepare.approving") : t("prepare.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
