"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { isTyping, opensAsk } from "@/lib/review";
import { useDesktop } from "@/lib/useDesktop";
import { AskThread } from "./AskThread";

export interface AskDrawerProps {
  sessionId: string;
  /** Spoken language of the video: answers quote it, so they carry `lang`. */
  language: string | null;
  hasVideo: boolean;
  videoRemoved: boolean;
  /** Example questions for the empty drawer (from the session's topics and names); a click fills the input. */
  examples: string[];
  open: boolean;
  onOpenChange(next: boolean): void;
  /** The panel opened by itself on load (`useAskDock`): focus stays on the page until the journalist opens Ask. */
  autoOpened?: boolean;
}

/**
 * Where focus goes when the panel opens: the question box when the journalist opened it (button, `/`, the phone
 * banner's Open), nowhere when it opened by itself, so keyboard and screen-reader users stay on the page.
 */
export const askTakesFocus = (autoOpened: boolean): boolean => !autoOpened;

/**
 * The Ask drawer: `/` (or the Ask button) opens a side panel where the journalist questions this video. The
 * conversation itself is `AskThread`; this is its frame (trigger, `/`, dialog, title, room beside the page).
 */
export function AskDrawer({ sessionId, language, hasVideo, videoRemoved, examples, open, onOpenChange, autoOpened = false }: AskDrawerProps) {
  const desktop = useDesktop();
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The question box: focused when the drawer opens (the example buttons above it would take focus otherwise). */
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Beside the page, not over it: the page makes room for the 28 rem panel (`sm:max-w-md`) so nothing hides under it.
  useEffect(() => {
    if (!open || !desktop) return;
    const previous = document.body.style.paddingRight;
    document.body.style.paddingRight = "28rem";
    return () => {
      document.body.style.paddingRight = previous;
    };
  }, [open, desktop]);

  /** The journalist opens Ask: an already open panel (one that opened by itself) gets focus in its question box. */
  function openByUser() {
    if (open) inputRef.current?.focus();
    onOpenChange(true);
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // Another dialog (a confirm) blocks `/`; Ask's own open panel doesn't: `/` then moves focus into it.
    const dialogOpen = [...document.querySelectorAll("[role='dialog']:not([hidden])")].some((d) => !inputRef.current || !d.contains(inputRef.current));
    if (!opensAsk(e, { typing: isTyping(e.target), dialogOpen })) return;
    e.preventDefault();
    openByUser();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Button ref={triggerRef} type="button" variant="outline" size="sm" onClick={openByUser} aria-keyshortcuts="/">
        {t("ask.open")}
        {/* The key hint means nothing on a touch screen. */}
        <kbd className="rounded border border-border bg-stone-50 px-1 font-mono text-[11px] text-muted-foreground pointer-coarse:hidden">/</kbd>
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange} modal={!desktop} disablePointerDismissal={desktop}>
        <DialogContent
          finalFocus={triggerRef}
          initialFocus={askTakesFocus(autoOpened) ? inputRef : false}
          overlayClassName="lg:hidden"
          showCloseButton
          keepMounted
          className="top-0 right-0 left-auto flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-md lg:border-l lg:border-border lg:shadow-xl"
        >
          <div className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle>{t(hasVideo ? "ask.title" : "ask.titleAudio")}</DialogTitle>
            <DialogDescription id="ask-description" className="mt-1 text-xs text-muted-foreground">{t(hasVideo ? "ask.hint" : "ask.hintAudio")}</DialogDescription>
          </div>
          <AskThread
            sessionId={sessionId}
            language={language}
            hasVideo={hasVideo}
            videoRemoved={videoRemoved}
            examples={examples}
            active={open}
            inputRef={inputRef}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
