"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Busy } from "@/components/ui/spinner";
import { t } from "@/lib/i18n";
import { zipClipOf, zipEntries, ZIP_CHOICES, type ZipChoice } from "@/lib/zipNames";
import type { ExportClipData } from "@/components/ExportList";

const HELP: Record<ZipChoice, "burnedHelp" | "filesHelp" | "plainHelp"> = { burned: "burnedHelp", files: "filesHelp", plain: "plainHelp" };

/** "Download all": three choices built from stored files; "burned" lists the clips it leaves out. Downloading is a plain link. */
export function DownloadAllDialog({ sessionId, clips }: { sessionId: string; clips: ExportClipData[] }) {
  const [open, setOpen] = useState(false);
  const zipClips = clips.map(zipClipOf);
  const plans = Object.fromEntries(ZIP_CHOICES.map((c) => [c, zipEntries(zipClips, c)])) as Record<ZipChoice, ReturnType<typeof zipEntries>>;
  const first = ZIP_CHOICES.find((c) => plans[c].entries.length > 0) ?? null;
  const [picked, setPicked] = useState<ZipChoice | null>(null);
  const choice = picked && plans[picked].entries.length > 0 ? picked : first;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (starting && !next) return;
    setOpen(next);
    if (!next) setError(null);
  }

  /** Asks the server first (same checks, nothing streamed), so a failure shows here and not as a raw page; then a normal browser download. */
  async function download() {
    if (choice === null || starting) return;
    const href = `/api/sessions/${sessionId}/download?choice=${choice}`;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`${href}&check=1`, { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 409 ? t("exportScreen.nothingToDownload") : t("exportScreen.zipFailed"));
        return;
      }
      const a = document.createElement("a");
      a.href = href;
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
      setOpen(false);
    } catch {
      setError(t("exportScreen.zipFailed"));
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <Button
          type="button"
          variant="outline"
          className="h-9 px-4 font-semibold"
          disabled={first === null}
          aria-describedby={first === null ? "download-all-hint" : undefined}
          onClick={() => setOpen(true)}
        >
          {t("exportScreen.downloadAll")}
        </Button>
        {first === null && (
          <p id="download-all-hint" className="text-xs text-muted-foreground">
            {t("exportScreen.nothingToDownload")}
          </p>
        )}
      </div>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("exportScreen.downloadAllTitle")}</DialogTitle>
            <DialogDescription>{t("exportScreen.downloadAllIntro")}</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2">
            <legend className="sr-only">{t("exportScreen.downloadAllTitle")}</legend>
            {ZIP_CHOICES.map((c) => {
              const n = plans[c].entries.length;
              return (
                <label
                  key={c}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2.5 has-checked:border-foreground has-disabled:cursor-not-allowed has-disabled:opacity-60 has-focus-visible:ring-2 has-focus-visible:ring-brand"
                >
                  <input type="radio" name="zip-choice" value={c} checked={choice === c} disabled={n === 0} onChange={() => setPicked(c)} className="mt-1 accent-[var(--brand)]" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      {t(`exportScreen.choice.${c}`)} · {n === 1 ? t("exportScreen.choiceCountOne") : t("exportScreen.choiceCount", { n })}
                    </span>
                    <span className="block text-xs text-muted-foreground">{t(`exportScreen.choice.${HELP[c]}`)}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {choice === "burned" && plans.burned.skipped.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t("exportScreen.skippedBurned")}</p>
              <ul className="mt-1 list-disc pl-5">
                {plans.burned.skipped.map((s) => (
                  <li key={s.n} dir="auto">
                    {t("exportScreen.skippedItem", { n: s.n, title: s.title || t("exportScreen.clipHeading", { n: s.n }) })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={starting} onClick={() => onOpenChange(false)}>
              {t("exportScreen.cancel")}
            </Button>
            {choice !== null && (
              <Button type="button" className="bg-brand text-brand-foreground hover:brightness-90" disabled={starting} onClick={() => void download()}>
                <Busy busy={starting}>{starting ? t("exportScreen.downloadingZip") : t("exportScreen.downloadZip")}</Busy>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
