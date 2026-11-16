"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LibraryAskMessage } from "@digestor/core";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Busy, Spinner } from "@/components/ui/spinner";
import { asToolCalls, isStalePending, verifyResult, type VerifyState } from "@/lib/askText";
import { answerBlocks, glueCitationPunctuation, linkifyCitations, type GluedPart } from "@/lib/libraryAskText";
import { errorMessage } from "@/lib/http";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const MAX_QUESTION = 500;
const COUNTER_FROM = 400;
const POLL_MS = 2000;
const CITE =
  "whitespace-nowrap rounded bg-stone-100 px-1 font-mono text-xs font-medium text-foreground underline decoration-dotted underline-offset-2 outline-none hover:bg-stone-200 focus-visible:ring-2 focus-visible:ring-brand";

/** From this width the drawer is a side panel beside the Sessions list (Tailwind `lg`); below it a modal sheet. */
const DESKTOP = "(min-width: 1024px)";
function useDesktop(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(DESKTOP);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}

type Message = Omit<LibraryAskMessage, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt?: string };

function verifyLine(v: VerifyState): string {
  if (v.kind === "ok") return t("ask.verify.ok");
  if (v.kind === "failed") return t("ask.verify.failed");
  if (v.kind === "unconfirmed") return v.n === 1 ? t("ask.verify.unconfirmedOne") : t("ask.verify.unconfirmed", { n: v.n });
  return v.n === 1 ? t("ask.verify.uncheckedOne") : t("ask.verify.unchecked", { n: v.n });
}

const working = (m: Message) => m.role === "assistant" && (m.status === "pending" || m.status === "running");

/**
 * Ask across videos, on the Sessions page: one conversation over every video that can still be searched. Read-only:
 * answers cite `[S2 00:12:03]`, shown as links to that video with the time (the Briefing page has no time parameter);
 * a cited video that was deleted since shows as plain text.
 */
export function LibraryAsk() {
  const desktop = useDesktop();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Set on each load (never during render: the button sits in the page's static shell, where Date.now() can't run).
  const [now, setNow] = useState(0);

  // Beside the list, not over it: the page makes room for the 28 rem panel.
  useEffect(() => {
    if (!open || !desktop) return;
    const previous = document.body.style.paddingRight;
    document.body.style.paddingRight = "28rem";
    return () => {
      document.body.style.paddingRight = previous;
    };
  }, [open, desktop]);

  const load = useCallback(async (quiet: boolean) => {
    try {
      const res = await fetch("/api/library-ask");
      if (!res.ok) throw new Error("load");
      const body = (await res.json()) as { messages: Message[]; live: string[] };
      setMessages(body.messages);
      setLive(new Set(body.live));
      setNow(Date.now());
      setLoadError(false);
    } catch {
      if (!quiet) setLoadError(true);
    }
  }, []);

  function openAsk() {
    setOpen(true);
    void load(false);
  }

  const isWaiting = (m: Message) => working(m) && !isStalePending(m.updatedAt ?? m.createdAt, now);
  const hasPending = messages.some(isWaiting);
  useEffect(() => {
    if (!open || !hasPending) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void load(true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, hasPending, load]);

  // The latest question at the top of the list (its answer below it), never scrolled away under the drawer's header;
  // an answer arriving later doesn't move it.
  const lastQuestionId = messages.findLast((m) => m.role === "user")?.id;
  useEffect(() => {
    if (!open || !lastQuestionId) return;
    const frame = requestAnimationFrame(() => {
      const box = scroller.current;
      const question = box?.querySelector<HTMLElement>(`[data-question="${lastQuestionId}"]`);
      if (!box || !question) return;
      box.scrollTop += question.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, lastQuestionId]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const question = text.trim();
    if (sending || question.length === 0 || text.length > MAX_QUESTION) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/library-ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, t("ask.sendFailed")));
      const body = (await res.json()) as { question: Message; answer: Message };
      setMessages((m) => [...m, body.question, body.answer]);
      setText("");
    } catch (err) {
      setSendError(err instanceof Error && err.message ? err.message : t("ask.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  const count = text.length;
  const tooLong = count > MAX_QUESTION;
  const canSend = !sending && text.trim().length > 0 && !tooLong;

  return (
    <>
      <Button ref={triggerRef} type="button" variant="outline" className="h-9" onClick={openAsk}>
        {t("libraryAsk.open")}
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? openAsk() : setOpen(false))} modal={!desktop} disablePointerDismissal={desktop}>
        <DialogContent
          finalFocus={triggerRef}
          overlayClassName="lg:hidden"
          showCloseButton
          className="top-0 right-0 left-auto flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-md lg:border-l lg:border-border lg:shadow-xl"
        >
          <div className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle>{t("libraryAsk.title")}</DialogTitle>
            <DialogDescription id="library-ask-description" className="mt-1 text-xs text-muted-foreground">
              {t("libraryAsk.hint")}
            </DialogDescription>
          </div>

          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
            {loadError && (
              <p role="alert" className="mb-2 text-xs text-red-700">
                {t("ask.loadFailed")}
              </p>
            )}
            {messages.length === 0 && !loadError && <p className="text-sm text-muted-foreground">{t("libraryAsk.empty")}</p>}
            <ol aria-live="polite" aria-relevant="additions" className="grid gap-3">
              {messages.map((m) => (
                <MessageItem key={m.id} message={m} live={live} stale={working(m) && !isWaiting(m)} />
              ))}
            </ol>
          </div>

          <form onSubmit={send} className="border-t border-border bg-white p-3">
            <label htmlFor="library-ask-input" className="sr-only">
              {t("ask.inputLabel")}
            </label>
            <Textarea
              id="library-ask-input"
              maxLength={MAX_QUESTION}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t("libraryAsk.placeholder")}
              aria-invalid={tooLong}
              aria-describedby="library-ask-hint library-ask-description"
              rows={2}
              className="max-h-32 min-h-16 resize-none bg-white"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p id="library-ask-hint" className="min-h-4 min-w-0 text-xs text-muted-foreground">
                {count >= COUNTER_FROM ? (
                  <span className={tooLong ? "font-semibold text-red-700" : undefined}>{t("ask.counter", { n: count, max: MAX_QUESTION })}</span>
                ) : (
                  // The pay hint: each question is a paid AI call (an estimate; rates in core cost.ts).
                  t("cost.libraryQuestion")
                )}
              </p>
              <Button type="submit" size="sm" disabled={!canSend} className="bg-brand text-white hover:brightness-90">
                <Busy busy={sending}>{sending ? t("ask.sending") : t("ask.send")}</Busy>
              </Button>
            </div>
            {sendError && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {sendError}
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MessageItem({ message, live, stale }: { message: Message; live: ReadonlySet<string>; stale: boolean }) {
  if (message.role === "user") {
    return (
      <li data-question={message.id} className="ml-6 rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">
        <span className="sr-only">{t("ask.you")}: </span>
        <p dir="auto" className="whitespace-pre-wrap break-words">
          {message.text}
        </p>
      </li>
    );
  }
  const sources = message.sources ?? [];
  const verified = message.status === "done" ? verifyResult(asToolCalls(message.toolCalls)) : null;
  return (
    <li className="mr-2 grid gap-2 rounded-xl border border-border bg-white px-3 py-2 text-sm">
      <span className="sr-only">{t("ask.answer")}: </span>
      {working(message) && !stale && (
        <p className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Spinner />
          {t("libraryAsk.thinking")}
        </p>
      )}
      {working(message) && stale && (
        <p role="alert" className="text-red-700">
          {t("ask.tooSlow")}
        </p>
      )}
      {message.status === "failed" && (
        <p role="alert" className="break-words text-red-700">
          {message.text}
        </p>
      )}
      {message.status === "done" && (
        <div dir="auto" className="grid gap-2 break-words">
          {answerBlocks(message.text).map((block, b) =>
            block.kind === "text" ? (
              <p key={b} className="whitespace-pre-wrap">
                <AnswerText text={block.text} sources={sources} live={live} />
              </p>
            ) : (
              <ul key={b} className="grid list-disc gap-1 pl-5 marker:text-muted-foreground">
                {block.items.map((item, i) => (
                  <li key={i}>
                    <AnswerText text={item} sources={sources} live={live} />
                  </li>
                ))}
              </ul>
            ),
          )}
        </div>
      )}
      {verified && <p className="text-xs text-muted-foreground">{verifyLine(verified)}</p>}
      {message.status === "done" && sources.length > 0 && (
        <details className="group text-xs text-muted-foreground">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand">
            <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            {t("libraryAsk.sources", { n: sources.length })}
          </summary>
          <ul aria-label={t("libraryAsk.sourcesLabel")} className="mt-1 grid gap-0.5 pl-4">
            {sources.map((s) => (
              <li key={s.label} dir="auto" className="break-words">
                {live.has(s.sessionId) ? (
                  <Link href={`/s/${s.sessionId}`} className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand">
                    {t("libraryAsk.source", { label: s.label, title: s.title })}
                  </Link>
                ) : (
                  t("libraryAsk.sourceGone", { label: s.label, title: s.title })
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** One paragraph or list item of an answer, its citations as links (plain text when the video is gone). */
function AnswerText({ text, sources, live }: { text: string; sources: NonNullable<Message["sources"]>; live: ReadonlySet<string> }) {
  return glueCitationPunctuation(linkifyCitations(text, sources, live)).map((part: GluedPart, i) => {
    if (part.kind === "text") return part.value;
    const label = `${part.label} ${part.time}`;
    const trailing = "trailing" in part ? part.trailing : "";
    let chip: React.ReactNode;
    if (!part.live || !part.source) {
      chip = (
        <span
          dir="ltr"
          className={cn("whitespace-nowrap rounded bg-stone-100 px-1 font-mono text-xs text-muted-foreground", trailing && "pr-0.5")}
          title={part.source ? t("libraryAsk.citeGone", { title: part.source.title, time: part.time }) : undefined}
        >
          {label}
        </span>
      );
    } else {
      const name = t("libraryAsk.cite", { title: part.source.title, time: part.time });
      chip = (
        <Link href={`/s/${part.source.sessionId}`} dir="ltr" aria-label={name} title={name} className={cn(CITE, trailing && "pr-0.5")}>
          {label}
        </Link>
      );
    }
    // The punctuation after a citation stays on its line, right after the chip.
    return trailing ? (
      <span key={i} className="whitespace-nowrap">
        {chip}
        {trailing}
      </span>
    ) : (
      <Fragment key={i}>{chip}</Fragment>
    );
  });
}
