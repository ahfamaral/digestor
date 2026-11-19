"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Copy quote with source": copies a ready-made text (the quote plus who said it, when and where to check it) to the
 * clipboard. Labels come from the caller so the journalist flow (`t()`) and the monitor (`tm()`) both use it.
 */
export function CopyQuote({
  text,
  label,
  copiedLabel,
  failedLabel,
  ariaLabel,
  className,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  /** An accessible name naming what is copied, when the visible label repeats on a page (the live text still speaks). */
  ariaLabel?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(id);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <Button type="button" variant="ghost" size="sm" className={className} aria-label={ariaLabel} onClick={copy}>
      <span aria-live="polite">{state === "copied" ? copiedLabel : state === "failed" ? failedLabel : label}</span>
    </Button>
  );
}
