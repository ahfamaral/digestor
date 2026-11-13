"use client";

import { MediaPlayer } from "@/components/MediaPlayer";
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { formatTimestamp, type AskAction, type AskMessageWithActions, type AskToolCallRecord, type SelectionStatus, type ToolApprovalResolution } from "@digestor/core";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  asToolCalls, awaitsApproval, formatToolCall, isChange, packageOutcome, parseApprovalPayload, isStalePending, isWorkingOn, linkifyTimestamps, parseBulkPayload, planSelectionUndo, sourceLines, verifyResult, type VerifyState,
} from "@/lib/askText";
import { ApprovalCard } from "./ApprovalCard";
import { errorMessage } from "@/lib/http";
import { t } from "@/lib/i18n";
import { isTyping, opensAsk } from "@/lib/review";
import { Busy, Spinner } from "@/components/ui/spinner";

const MAX_QUESTION = 500;
/** The counter appears this close to the limit. */
const COUNTER_FROM = 400;
const POLL_MS = 2000;
const CHIP = "inline-flex h-6 items-center rounded-md border border-border bg-white px-2 text-xs font-medium outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50";

/** From this width the drawer is a side panel beside the Briefing (Tailwind `lg`); below it a modal sheet. */
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

type Message = Omit<AskMessageWithActions, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt?: string };
/** A decision on a card: confirm/dismiss a bulk selection, or approve/edit/reject an Ask change. */
type Decision = { decision: "confirm" | "dismiss" } | ToolApprovalResolution;

export interface AskDrawerProps {
  sessionId: string;
  /** Spoken language of the video: answers quote it, so they carry `lang`. */
  language: string | null;
  hasVideo: boolean;
  videoRemoved: boolean;
}

/**
 * The Ask drawer: `/` (or the Ask button) opens a side panel where the journalist questions this video. Answers come
 * from stored data, with `[hh:mm:ss]` links that play in the drawer's own preview player (the page behind a modal
 * drawer is inert, so it can't offer one). Tool calls show as chips; changes can be undone and bulk ones wait for a click.
 * Before Ask changes a clip or selection, its answer pauses on an approval card (Approve / Edit / Reject).
 */
/** The verify chip's state in words. */
function verifyLine(v: VerifyState): string {
  if (v.kind === "ok") return t("ask.verify.ok");
  if (v.kind === "failed") return t("ask.verify.failed");
  if (v.kind === "unconfirmed") return v.n === 1 ? t("ask.verify.unconfirmedOne") : t("ask.verify.unconfirmed", { n: v.n });
  return v.n === 1 ? t("ask.verify.uncheckedOne") : t("ask.verify.unchecked", { n: v.n });
}

export function AskDrawer({ sessionId, language, hasVideo, videoRemoved }: AskDrawerProps) {
  const router = useRouter();
  const lang = language ?? undefined;
  const desktop = useDesktop();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ ms: number; n: number } | null>(null);
  /** Client-side only: chips whose change was undone, by `<messageId>:<index>`. */
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Answers being worked on at the last load: one that finished since may have changed clips, so the page refreshes. */
  const working = useRef<Set<string>>(new Set());

  // Beside the page, not over it: the page makes room for the 28 rem panel (`sm:max-w-md`) so nothing hides under it.
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
      const res = await fetch(`/api/sessions/${sessionId}/ask`);
      if (!res.ok) throw new Error("load");
      const body = (await res.json()) as { messages: Message[] };
      const finished = body.messages.some((m) => working.current.has(m.id) && m.status === "done");
      working.current = new Set(body.messages.filter(isWorkingOn).map((m) => m.id));
      if (finished) router.refresh();
      setMessages(body.messages);
      setNow(Date.now());
      setLoadError(false);
    } catch {
      if (!quiet) setLoadError(true);
    }
  }, [sessionId, router]);

  /** Opens the drawer and loads the conversation (an event, not an effect: the fetch belongs to the action). */
  function openAsk() {
    setOpen(true);
    void load(false);
  }
  function onOpenChange(next: boolean) {
    if (next) openAsk();
    else setOpen(false);
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const dialogOpen = document.querySelector("[role='dialog']") !== null;
    if (!opensAsk(e, { typing: isTyping(e.target), dialogOpen })) return;
    e.preventDefault();
    openAsk();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "Taking too long" counts from the last status change: an answer resumed after an approval is fresh again.
  const isWaiting = (m: Message) => m.role === "assistant" && isWorkingOn(m) && !isStalePending(m.updatedAt ?? m.createdAt, now);
  const hasPending = messages.some(isWaiting);
  useEffect(() => {
    if (!open || !hasPending) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void load(true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, hasPending, load]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: "end" });
  }, [messages.length, hasPending]);

  function setBusyKey(key: string, on: boolean) {
    setBusy((b) => {
      const next = new Set(b);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }
  function setError(key: string, message: string | null) {
    setErrors((e) => {
      if (message) return { ...e, [key]: message };
      const rest = { ...e };
      delete rest[key];
      return rest;
    });
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const question = text.trim();
    if (sending || question.length === 0 || text.length > MAX_QUESTION) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, t("ask.sendFailed")));
      const body = (await res.json()) as { question: Omit<Message, "actions">; answer: Omit<Message, "actions"> };
      setMessages((m) => [...m, { ...body.question, actions: [] }, { ...body.answer, actions: [] }]);
      setText("");
    } catch (err) {
      setSendError(err instanceof Error && err.message ? err.message : t("ask.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  async function undo(key: string, call: AskToolCallRecord) {
    setBusyKey(key, true);
    setError(key, null);
    try {
      const clipIds = call.clipIds ?? (call.clipId ? [call.clipId] : []);
      if (clipIds.length > 0) {
        // A package undoes clip by clip; a clip already undone or changed since is reported, the rest still go.
        let failed: string | null = null;
        for (const clipId of clipIds) {
          const res = await fetch(`/api/clips/${clipId}/undo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ifActor: "ask" }),
          });
          if (!res.ok) failed ??= await errorMessage(res, t("ask.undoFailed"));
        }
        if (failed) throw new Error(failed);
      } else {
        // Only moments still at what the tool call set; anything the user changed since is left alone.
        const res = await fetch(`/api/sessions/${sessionId}/selections`);
        if (!res.ok) throw new Error(await errorMessage(res, t("ask.undoFailed")));
        const current = ((await res.json()) as { selections: Record<string, SelectionStatus> }).selections;
        const { restore, skipped } = planSelectionUndo(call, current);
        if (Object.keys(restore).length === 0) throw new Error(t("ask.undoNothing"));
        for (const [momentId, previous] of Object.entries(restore)) {
          const res = await fetch(`/api/moments/${momentId}/selection`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: previous }),
          });
          if (!res.ok) throw new Error(await errorMessage(res, t("ask.undoFailed")));
        }
        if (skipped > 0) setError(key, t("ask.undoPartial"));
      }
      setUndone((u) => new Set(u).add(key));
      router.refresh();
    } catch (err) {
      setError(key, err instanceof Error && err.message ? err.message : t("ask.undoFailed"));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function decide(action: AskAction, body: Decision) {
    const key = `action:${action.id}`;
    const fallback = action.kind === "tool_approval" ? t("ask.approval.failed") : t("ask.bulkFailed");
    setBusyKey(key, true);
    setError(key, null);
    try {
      const res = await fetch(`/api/ask-actions/${action.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const message = await errorMessage(res, fallback);
        if (res.status === 409) await load(true);
        throw new Error(message);
      }
      await load(true);
      if (body.decision === "confirm") router.refresh();
    } catch (err) {
      setError(key, err instanceof Error && err.message ? err.message : fallback);
    } finally {
      setBusyKey(key, false);
    }
  }

  const count = text.length;
  const tooLong = count > MAX_QUESTION;
  const canSend = !sending && text.trim().length > 0 && !tooLong;
  const previewSrc = preview ? `/api/files/${sessionId}/proxy.mp4#t=${(preview.ms / 1000).toFixed(1)}` : null;
  const previewLabel = preview ? t("ask.previewLabel", { time: formatTimestamp(preview.ms) }) : "";

  return (
    <>
      <Button ref={triggerRef} type="button" variant="outline" size="sm" onClick={openAsk} aria-keyshortcuts="/">
        {t("ask.open")}
        <kbd className="rounded border border-border bg-stone-50 px-1 font-mono text-[11px] text-muted-foreground">/</kbd>
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange} modal={!desktop} disablePointerDismissal={desktop}>
        <DialogContent
          finalFocus={triggerRef}
          overlayClassName="lg:hidden"
          showCloseButton
          className="top-0 right-0 left-auto flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-md lg:border-l lg:border-border lg:shadow-xl"
        >
          <div className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle>{t(hasVideo ? "ask.title" : "ask.titleAudio")}</DialogTitle>
            <DialogDescription id="ask-description" className="mt-1 text-xs text-muted-foreground">{t(hasVideo ? "ask.hint" : "ask.hintAudio")}</DialogDescription>
          </div>

          {preview && (
            <div className="border-b border-border bg-stone-50 px-4 py-2">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{previewLabel}</span>
                <button type="button" className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand" onClick={() => setPreview(null)}>
                  {t("ask.previewClose")}
                </button>
              </div>
              {hasVideo ? (
                <MediaPlayer key={preview.n} kind="video" autoPlay src={previewSrc ?? undefined} label={previewLabel} className="mx-auto aspect-video max-h-40 w-full rounded-lg bg-black" />
              ) : (
                <MediaPlayer key={preview.n} kind="audio" autoPlay src={previewSrc ?? undefined} label={previewLabel} className="w-full" />
              )}
            </div>
          )}

          {videoRemoved && (
            <p id="ask-video-removed" role="status" className="border-b border-border bg-stone-100 px-4 py-2 text-xs text-stone-800">
              {t("preview.videoRemoved")}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
            {loadError && (
              <p role="alert" className="mb-2 text-xs text-red-700">
                {t("ask.loadFailed")}
              </p>
            )}
            {messages.length === 0 && !loadError && <p className="text-sm text-muted-foreground">{t("ask.empty")}</p>}
            <ol aria-live="polite" aria-relevant="additions" className="grid gap-3">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  sessionId={sessionId}
                  lang={lang}
                  videoRemoved={videoRemoved}
                  stale={isWorkingOn(m) && !isWaiting(m)}
                  undone={undone}
                  busy={busy}
                  errors={errors}
                  onTime={(ms) => setPreview((p) => ({ ms, n: (p?.n ?? 0) + 1 }))}
                  onUndo={undo}
                  onDecide={decide}
                />
              ))}
            </ol>
            <div ref={listEnd} />
          </div>

          <form onSubmit={send} className="border-t border-border bg-white p-3">
            <label htmlFor="ask-input" className="sr-only">
              {t("ask.inputLabel")}
            </label>
            <Textarea
              id="ask-input"
              maxLength={MAX_QUESTION}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t("ask.placeholder")}
              aria-invalid={tooLong}
              aria-describedby="ask-hint ask-description"
              rows={2}
              className="max-h-32 min-h-16 resize-none bg-white"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p id="ask-hint" className="min-h-4 min-w-0 text-xs text-muted-foreground">
                {count >= COUNTER_FROM && (
                  <span className={tooLong ? "font-semibold text-red-700" : undefined}>{t("ask.counter", { n: count, max: MAX_QUESTION })}</span>
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

function MessageItem({
  message, sessionId, lang, videoRemoved, stale, undone, busy, errors, onTime, onUndo, onDecide,
}: {
  message: Message;
  sessionId: string;
  lang: string | undefined;
  videoRemoved: boolean;
  stale: boolean;
  undone: Set<string>;
  busy: Set<string>;
  errors: Record<string, string>;
  onTime: (ms: number) => void;
  onUndo: (key: string, call: AskToolCallRecord) => void;
  onDecide: (action: AskAction, body: Decision) => void;
}) {
  if (message.role === "user") {
    return (
      <li className="ml-6 rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">
        <span className="sr-only">{t("ask.you")}: </span>
        <p lang={lang} dir="auto" className="whitespace-pre-wrap break-words">
          {message.text}
        </p>
      </li>
    );
  }
  const calls = asToolCalls(message.toolCalls);
  // Calls that changed something keep their Undo; everything else a call looked at goes under "Sources".
  const changes = calls.flatMap((call, i) => (isChange(call) ? [{ call, key: `${message.id}:${i}` }] : []));
  const sources = calls.flatMap(sourceLines);
  // The n-th package card of the answer goes with its n-th make_clip_package record.
  const packageCards = message.actions.filter((a) => a.kind === "tool_approval" && parseApprovalPayload(a.payload)?.calls.some((c) => c.package));
  const verified = message.status === "done" ? verifyResult(calls) : null;
  return (
    <li className="mr-2 grid gap-2 rounded-xl border border-border bg-white px-3 py-2 text-sm">
      <span className="sr-only">{t("ask.answer")}: </span>
      {isWorkingOn(message) && !stale && <p className="inline-flex items-center gap-1.5 text-muted-foreground"><Spinner />{t("ask.thinking")}</p>}
      {awaitsApproval(message) && <p className="text-muted-foreground">{t("ask.approval.waiting")}</p>}
      {isWorkingOn(message) && stale && (
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
        <p lang={lang} dir="auto" className="whitespace-pre-wrap break-words">
          {linkifyTimestamps(message.text).map((part, i) =>
            part.kind === "text" ? (
              part.value
            ) : (
              <button
                key={i}
                type="button"
                disabled={videoRemoved}
                aria-describedby={videoRemoved ? "ask-video-removed" : undefined}
                aria-label={t("ask.playLabel", { time: formatTimestamp(part.ms) })}
                onClick={() => onTime(part.ms)}
                dir="ltr"
                className="rounded bg-stone-100 px-1 font-mono text-xs font-medium text-foreground underline decoration-dotted underline-offset-2 outline-none hover:bg-stone-200 focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                {part.label}
              </button>
            ),
          )}
        </p>
      )}
      {verified && <p className="text-xs text-muted-foreground">{verifyLine(verified)}</p>}
      {changes.length > 0 && (
        <ul className="grid gap-1.5" aria-label={t("ask.toolCall")}>
          {changes.map(({ call, key }) => {
            const label = formatToolCall(call);
            return (
              <li key={key} className="grid gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {undone.has(key) ? (
                    <span className="text-xs text-muted-foreground">{t("ask.undone")}</span>
                  ) : (
                    <button type="button" className={CHIP} disabled={busy.has(key)} aria-label={t("ask.undoLabel", { call: label })} onClick={() => onUndo(key, call)}>
                      <Busy busy={busy.has(key)}>{busy.has(key) ? t("ask.undoing") : t("ask.undo")}</Busy>
                    </button>
                  )}
                </div>
                {call.result && <p className="break-words text-xs text-muted-foreground">{call.result}</p>}
                {errors[key] && (
                  <p role="alert" className="text-xs text-red-700">
                    {errors[key]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {sources.length > 0 && (
        <details className="group text-xs text-muted-foreground">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand">
            <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            {t("ask.sources", { n: sources.length })}
          </summary>
          <ul aria-label={t("ask.sourcesLabel")} className="mt-1 grid gap-0.5 pl-4">
            {sources.map((line, i) => (
              <li key={i} lang={line.kind === "transcript" || line.kind === "speech" ? undefined : lang} dir={line.kind === "transcript" || line.kind === "speech" ? undefined : "auto"} className="break-words">
                {t(`ask.source.${line.kind}`, { text: line.text })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {message.actions.map((action) =>
        action.kind === "tool_approval" ? (
          <ApprovalCard
            key={action.id}
            action={action}
            outcome={packageCards.includes(action) ? packageOutcome(calls, packageCards.indexOf(action)) : null}
            sessionId={sessionId}
            lang={lang}
            busy={busy.has(`action:${action.id}`)}
            error={errors[`action:${action.id}`]}
            videoRemoved={videoRemoved}
            onDecide={onDecide}
          />
        ) : (
          <ActionItem key={action.id} action={action} busy={busy.has(`action:${action.id}`)} error={errors[`action:${action.id}`]} onDecide={onDecide} />
        ),
      )}
    </li>
  );
}

function ActionItem({
  action, busy, error, onDecide,
}: {
  action: AskAction;
  busy: boolean;
  error: string | undefined;
  onDecide: (action: AskAction, body: Decision) => void;
}) {
  const payload = parseBulkPayload(action.payload);
  if (action.kind !== "bulk_selection" || !payload) return null;
  const n = payload.momentIds.length;
  const summary = payload.status
    ? n === 1
      ? t("ask.bulkSetOne", { status: t(`ask.bulkStatus.${payload.status}`) })
      : t("ask.bulkSet", { n, status: t(`ask.bulkStatus.${payload.status}`) })
    : n === 1
      ? t("ask.bulkClearOne")
      : t("ask.bulkClear", { n });
  return (
    <div className="grid gap-1.5 rounded-lg border border-border bg-stone-50 p-2">
      <p className="text-xs">{summary}</p>
      {action.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => onDecide(action, { decision: "confirm" })}>
            <Busy busy={busy}>{busy ? t("ask.bulkApplying") : n === 1 ? t("ask.bulkApplyOne") : t("ask.bulkApply", { n })}</Busy>
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDecide(action, { decision: "dismiss" })}>
            {t("ask.bulkDismiss")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{action.status === "confirmed" ? t("ask.bulkApplied") : t("ask.bulkDismissed")}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
