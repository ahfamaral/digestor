"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  formatMinutes, formatTimestamp, type ClipStatus, type HighlightTypeId, type MomentWithHighlights, type SelectionStatus, type Topic,
} from "@digestor/core";
import { AppBar } from "@/components/AppBar";
import {
  DEFAULT_FILTERS, SHOW_HIDDEN_FILTERS, filterMoments, fromSearchParams, groupByTopic, hiddenApprovedCount, toSearchParams,
  type BriefingFilters,
} from "@/lib/briefingFilters";
import { errorMessage } from "@/lib/http";
import {
  ACTION_STATUS, actionForKey, approvedMomentIds, asClipStatus, asSelection, flattenViews, isTyping, moveFocus, resolveFocus,
} from "@/lib/review";
import { StatusQueue } from "@/lib/statusQueue";
import { t, type MessageKey } from "@/lib/i18n";
import { Controls, type SpeakerOption } from "./Controls";
import { MomentRow, type RowContext } from "./MomentRow";

export interface FullBriefingProps {
  session: { id: string; title: string; language: string | null; hasVideo: boolean; videoRemoved: boolean };
  analysis: { id: string; version: number };
  topics: Topic[];
  /** Official moments of the current analysis plus the owner's personal ones. */
  moments: MomentWithHighlights[];
  /** Transcript text per moment id. */
  excerpts: Record<string, string>;
  /** The owner's selections on these moments (no entry = proposed). */
  selections: Record<string, SelectionStatus>;
  speakers: SpeakerOption[];
  types: HighlightTypeId[];
  /** Selections left on an earlier analysis version, or null. */
  earlier: { count: number; version: number } | null;
}

const NOTICE = "mb-3 rounded-xl border px-3 py-2 text-sm";
const ANNOUNCE: Record<SelectionStatus, MessageKey> = {
  approved: "briefing.announceApproved",
  neutral: "briefing.announceNeutral",
  rejected: "briefing.announceRejected",
};

/** Persists one selection; throws with the API's sentence on failure. */
async function sendSelection(id: string, status: ClipStatus): Promise<void> {
  const res = await fetch(`/api/moments/${id}/selection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: asSelection(status) }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, t("briefing.saveFailed")));
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Full briefing: every moment of the session by topic, with instant on-screen filters (kept in the URL), keyboard
 * triage (A/N/R, E, ↓/↑) and "Confirm selection → Prepare clips". Render it with `key={analysis.id}`.
 */
export function FullBriefing({ session, analysis, topics, moments, excerpts, selections, speakers, types, earlier }: FullBriefingProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const lang = session.language ?? undefined;
  const [filters, setFilters] = useState<BriefingFilters>(() => fromSearchParams(searchParams, { speakers: speakers.map((s) => s.id) }));
  const [statuses, setStatuses] = useState<Record<string, SelectionStatus>>(selections);
  const [focus, setFocus] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const [keyboardMoved, setKeyboardMoved] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState<"confirm" | "prepare" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function setError(id: string, message: string | null) {
    setErrors((e) => {
      if (message) return { ...e, [id]: message };
      if (!(id in e)) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  }

  // Optimistic, per-moment latest-wins selection updates (see lib/statusQueue).
  const [queue] = useState(
    () =>
      new StatusQueue({
        send: sendSelection,
        onDisplay: (id, status) =>
          setStatuses((all) => {
            const s = asSelection(status);
            if (s) return { ...all, [id]: s };
            const next = { ...all };
            delete next[id];
            return next;
          }),
        onError: (id, message) => setError(id, message),
      }),
  );

  // Filters live in the URL (defaults omitted) so reloads and back links keep them. history.replaceState updates the
  // address without a new history entry, a scroll jump or a server round trip; Next keeps useSearchParams in sync.
  useEffect(() => {
    const qs = toSearchParams(filters);
    if (window.location.search.replace(/^\?/, "") === qs) return;
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, [filters]);

  const views = useMemo(() => filterMoments(moments, statuses, filters, topics), [moments, statuses, filters, topics]);
  const groups = useMemo(() => groupByTopic(views, topics), [views, topics]);
  const order = useMemo(() => flattenViews(views).map((v) => v.moment.id), [views]);
  const currentId = resolveFocus(order, focus);
  const titleOf = useMemo(() => new Map(moments.map((m) => [m.id, m.title])), [moments]);
  const approved = useMemo(() => approvedMomentIds(moments, statuses), [moments, statuses]);
  const hiddenApproved = useMemo(() => hiddenApprovedCount(views, approved), [views, approved]);
  const topicNo = useMemo(() => new Map(topics.map((tp, i) => [tp.id, i + 1])), [topics]);

  const focusRow = (id: string) => setFocus({ id, index: Math.max(0, order.indexOf(id)) });

  // After a keyboard move (or when the focused row left the list), real focus follows the current row.
  const rowFocusPending = useRef(false);
  useEffect(() => {
    if (!keyboardMoved || !currentId) return;
    const el = document.querySelector<HTMLElement>(`[data-moment-id="${currentId}"]`);
    if (!el) return;
    if (rowFocusPending.current || document.activeElement === document.body || !document.activeElement) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    rowFocusPending.current = false;
  }, [keyboardMoved, currentId]);

  function setStatus(id: string, status: SelectionStatus) {
    queue.set(id, status, asClipStatus(statuses[id] ?? null));
    setAnnouncement(t(ANNOUNCE[status], { title: titleOf.get(id) ?? "" }));
  }

  async function openInPrepare(id: string) {
    if (busy || session.videoRemoved) return;
    setBusy("prepare");
    setConfirmError(null);
    setAnnouncement(t("briefing.opening"));
    if (statuses[id] !== "approved") setStatus(id, "approved");
    await confirm([id]);
  }

  async function confirm(momentIds: string[]) {
    try {
      // Confirm exactly what was approved: let in-flight selection changes land first.
      const { failed } = await queue.idle();
      if (failed) {
        setConfirmError(t("briefing.someFailed"));
        setBusy(null);
        return;
      }
      const res = await fetch(`/api/sessions/${session.id}/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentIds }),
      });
      if (res.ok) {
        router.push(`/s/${session.id}/prepare`);
        return; // stay busy until Prepare clips takes over
      }
      setConfirmError(await errorMessage(res, t("briefing.confirmFailed")));
    } catch {
      setConfirmError(t("briefing.confirmFailed"));
    }
    setBusy(null);
  }

  // Next can keep this page (and its state) alive after navigating away: re-enable the buttons for when it comes back.
  useEffect(() => () => setBusy(null), []);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const dialogOpen = document.querySelector("[role='dialog']") !== null;
    const action = actionForKey(e, { typing: isTyping(e.target), dialogOpen });
    if (!action || !currentId) return;
    e.preventDefault();
    if (action === "next" || action === "prev") {
      const next = moveFocus(order, currentId, action === "next" ? 1 : -1);
      if (next) focusRow(next);
      rowFocusPending.current = true;
      setKeyboardMoved((n) => n + 1);
    } else if (action === "edit") {
      void openInPrepare(currentId);
    } else {
      focusRow(currentId);
      setStatus(currentId, ACTION_STATUS[action]);
      setKeyboardMoved((n) => n + 1);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx: RowContext = {
    sessionId: session.id,
    language: lang,
    hasVideo: session.hasVideo,
    videoRemoved: session.videoRemoved,
    focusedId: currentId,
    playingId: playing,
    excerpts,
    errors,
    onFocusRow: focusRow,
    onStatus: (id, s) => {
      focusRow(id);
      setStatus(id, s);
      // If the change takes the row out of the list, focus moves to the row now in its place (not to the page).
      setKeyboardMoved((n) => n + 1);
    },
    onPlay: (id) => setPlaying((p) => (p === id ? null : id)),
  };
  const isDefault = toSearchParams(filters) === "";
  const shown = order.length;
  const confirmDisabled = approved.length === 0 || busy !== null || session.videoRemoved;

  return (
    <>
      <AppBar current="Briefing" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6">
        <header className="mb-3">
          <Link href={`/s/${session.id}`} className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand">
            {t("briefing.backToPreview")}
          </Link>
          <h1 lang={lang} dir="auto" className="mt-1 text-xl font-bold tracking-tight break-words">
            {session.title}
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t("briefing.title")} · {t("preview.analysisVersion", { n: analysis.version })}
          </p>
        </header>

        {earlier && (
          <p role="status" className={`${NOTICE} border-border bg-white text-foreground`}>
            {earlier.count === 1
              ? t("briefing.earlierOne", { version: earlier.version })
              : t("briefing.earlierMany", { n: earlier.count, version: earlier.version })}
          </p>
        )}
        {session.videoRemoved && (
          <p id="video-removed" role="status" className={`${NOTICE} border-border bg-stone-100 text-stone-800`}>
            {t("preview.videoRemoved")}
          </p>
        )}

        {moments.length === 0 ? (
          <p className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">{t("briefing.none")}</p>
        ) : (
          <>
            <Controls filters={filters} onChange={setFilters} speakers={speakers} types={types} />

            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span aria-live="off">{shown === 1 ? t("briefing.shownOne") : t("briefing.shownMany", { n: shown })}</span>
              {!isDefault && (
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                  className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {t("briefing.reset")}
                </button>
              )}
            </div>

            {groups.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-white p-6 text-sm text-muted-foreground">{t("briefing.empty")}</p>
            ) : (
              <div className="grid gap-3">
                {groups.map((g) => (
                  <section
                    key={g.topic?.id ?? "outside"}
                    aria-labelledby={`topic-h-${g.topic?.id ?? "outside"}`}
                    className="rounded-xl border border-border bg-white/60 p-2 sm:p-3"
                  >
                    <h2 id={`topic-h-${g.topic?.id ?? "outside"}`} className="flex flex-wrap items-baseline gap-x-2.5 px-2 pt-1 pb-2 text-[15px] font-bold">
                      {g.topic ? (
                        <>
                          <span lang={lang} dir="auto">
                            {topicNo.get(g.topic.id)} · {g.topic.title}
                          </span>
                          <span className="font-mono text-xs font-normal text-muted-foreground">
                            {formatTimestamp(g.topic.startMs)} · {formatMinutes(g.topic.endMs - g.topic.startMs)}
                          </span>
                        </>
                      ) : (
                        t("briefing.outsideTopics")
                      )}
                    </h2>
                    <ul className="space-y-1">
                      {g.views.map((v) => (
                        <MomentRow key={v.moment.id} view={v} ctx={ctx} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="hidden text-xs text-muted-foreground md:block">
              <span className="sr-only">{t("briefing.keyboard")}: </span>
              <Kbd>A</Kbd> {t("briefing.keysApprove")} · <Kbd>N</Kbd> {t("briefing.keysNeutral")} · <Kbd>R</Kbd> {t("briefing.keysReject")} ·{" "}
              <Kbd>E</Kbd> {t("briefing.keysPrepare")} · <Kbd>↓</Kbd>
              <Kbd>↑</Kbd> {t("briefing.keysMove")}
            </p>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-muted-foreground">
                {approved.length === 1 ? t("briefing.approvedOne") : t("briefing.approvedMany", { n: approved.length })}
                {hiddenApproved > 0 && <> · {t("briefing.hiddenByFilters", { n: hiddenApproved })}</>}
              </span>
              {hiddenApproved > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters(SHOW_HIDDEN_FILTERS)}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {t("briefing.showHidden")}
                </button>
              )}
              <span title={approved.length === 0 ? t("briefing.confirmEmpty") : undefined}>
                <button
                  type="button"
                  disabled={confirmDisabled}
                  onClick={() => {
                    setBusy("confirm");
                    setConfirmError(null);
                    void confirm(approved);
                  }}
                  aria-describedby={session.videoRemoved ? "video-removed" : undefined}
                  className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "confirm" ? t("briefing.confirmBusy") : t("briefing.confirm")}
                </button>
              </span>
            </div>
          </div>
          {confirmError && (
            <p role="alert" className="mt-2 text-right text-xs text-red-700">
              {confirmError}
            </p>
          )}
        </footer>
      </main>
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mx-0.5 rounded border border-b-2 border-[#ddd9d0] bg-white px-1.5 text-[10px]">{children}</kbd>;
}
