"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { pauseAllMedia } from "@/lib/media";
import { t } from "@/lib/i18n";
import { Busy } from "@/components/ui/spinner";

/**
 * Asks before a one-click action that changes data or leaves the page. Opening it pauses any playing media (nothing
 * resumes it). Focus starts on Cancel, so Enter cancels; the action must be chosen on purpose. `onConfirm` throws to
 * keep the dialog open with its message shown. `estimate` states what a paid action will cost.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  busyLabel,
  cancelLabel,
  estimate,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  busyLabel?: string;
  /** Default "Cancel" (`t()`); the monitor passes its own language's word. */
  cancelLabel?: string;
  /** What will be paid, as a sentence ("Estimated cost: about $0.42 …"): its own line inside the description. */
  estimate?: string;
  onConfirm: () => Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A closed dialog forgets its error (adjusted during render, not in an effect, however the parent closes it).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setError(null);
  }
  useEffect(() => {
    if (open) pauseAllMedia();
  }, [open]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      console.error("confirm: action failed", err);
      setError(err instanceof Error && err.message ? err.message : t("confirm.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      {/* A confirm asks for a decision: the page behind it dims to half, so it's clear nothing else can be done until then. */}
      <DialogContent showCloseButton={false} initialFocus={cancelRef} overlayClassName="bg-black/50">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription dir="auto">
            {description}
            {estimate && (
              <span dir="auto" className="mt-2 block font-medium text-foreground">
                {estimate}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t("confirm.cancel")}
          </Button>
          <Button type="button" className="bg-brand text-brand-foreground hover:brightness-90 active:brightness-[0.82]" disabled={busy} onClick={() => void confirm()}>
            <Busy busy={busy}>{busy && busyLabel ? busyLabel : actionLabel}</Busy>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
