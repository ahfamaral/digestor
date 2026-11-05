"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  formatMinutes, formatTimestamp, type ClipStatus, type HighlightTypeId, type MomentWithHighlights, type SelectionStatus, type Topic,
} from "@digestor/core";
import { Button } from "@/components/ui/button";
import { AskDrawer } from "@/components/Ask/AskDrawer";
import { AppBar } from "@/components/AppBar";
import {
  DEFAULT_FILTERS, SHOW_HIDDEN_FILTERS, filterMoments, fromSearchParams, groupByTopic, hiddenApprovedCount, toSearchParams,
  type BriefingFilters,
} from "@/lib/briefingFilters";
import { errorMessage } from "@/lib/http";
import {
  approvedMomentIds, asClipStatus, asSelection, flattenViews, nextStatus,
} from "@/lib/review";
import { StatusQueue } from "@/lib/statusQueue";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { t, type MessageKey } from "@/lib/i18n";
import { Controls, type FocusChoice } from "./Controls";
import { WhosWhoDrawer } from "@/components/Names/WhosWho";
import type { NamesData, Voice, WhosWhoRow } from "@/lib/names";
import { MomentRow, type RowContext } from "./MomentRow";
import { Busy } from "@/components/ui/spinner";

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
  choices: FocusChoice[];
  /** Person ids speaking at least 3 s in each moment (Focus by person). */
  people: Record<string, string[]>;
  names: NamesData;
  /** A name changed after this analysis was written. */
  namesChanged: boolean;
  whoRows: WhosWhoRow[];
  /** Who to show per moment id (longest speaking first). */
  voices: Record<string, Voice[]>;
  sensitive: boolean;
  /** The analysis profile (a parliament session offers the official-record field in Who's who). */
  profile: string;
  types: HighlightTypeId[];
  /** Selections left on an earlier analysis version, or null. */
  earlier: { count: number; version: number } | null;
}

const NOTICE = "mb-3 rounded-xl border px-3 py-2 text-sm";
const ANNOUNCE: Record<SelectionStatus, MessageKey> = {
  approved: "briefing.announceApproved",
  rejected: "briefing.announceSkipped",
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

/** Where a "Find more" run stands for the focused person; "none" = never asked. */
interface FindMoreState {
  status: "none" | "pending" | "running" | "done" | "failed";
  momentCount: number;
  error: string | null;
  /** The run's id; its moments carry it as `findMoreRequestId`. */
  requestId?: string | null;
}
const FIND_MORE_POLL_MS = 3000;

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Full briefing: every moment of the session by topic, with instant on-screen filters (kept in the URL), keyboard
 * triage (A/N/R, E, ↓/↑) and "Confirm selection → Prepare clips". Render it with `key={analysis.id}`.
 */
export function FullBriefing({ session, analysis, topics, moments, excerpts, selections, choices, people, names, namesChanged, whoRows, voices, sensitive, profile, types, earlier }: FullBriefingProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const lang = session.language ?? undefined;
  const [whoOpen, setWhoOpen] = useState(false);
  const whoRef = useRef<HTMLButtonElement>(null);
  const [filters, setFilters] = useState<BriefingFilters>(() => fromSearchParams(searchParams, {
    speakers: choices.filter((c) => c.kind === "voice").map((c) => c.id),
    persons: choices.filter((c) => c.kind === "person").map((c) => c.id),
  }));
  const [statuses, setStatuses] = useState<Record<string, SelectionStatus>>(selections);
  const [playing, setPlaying] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState<"confirm" | "prepare" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // "Find more moments with <person>": the run's state per person, kept from the server and polled while it runs.
  const [findMore, setFindMore] = useState<Record<string, FindMoreState>>({});
  const fmSeen = useRef<Record<string, FindMoreState["status"]>>({});
  // Bumped by every click: a status read that started before it is older than the click and is ignored.
  const fmSeq = useRef(0);

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

  // Who speaks in each moment came from the server (it holds the words), so the person filter stays instant.
  const focusCtx = useMemo(() => ({ peopleByMoment: new Map(Object.entries(people).map(([id, ids]) => [id, new Set(ids)])) }), [people]);
  const views = useMemo(() => filterMoments(moments, statuses, filters, topics, focusCtx), [moments, statuses, filters, topics, focusCtx]);
  const groups = useMemo(() => groupByTopic(views, topics), [views, topics]);
  const order = useMemo(() => flattenViews(views).map((v) => v.moment.id), [views]);
  const titleOf = useMemo(() => new Map(moments.map((m) => [m.id, m.title])), [moments]);
  const approved = useMemo(() => approvedMomentIds(moments, statuses), [moments, statuses]);
  const hiddenApproved = useMemo(() => hiddenApprovedCount(views, approved), [views, approved]);
  const topicNo = useMemo(() => new Map(topics.map((tp, i) => [tp.id, i + 1])), [topics]);

  const focusedPerson = filters.person;
  const personName = focusedPerson ? (choices.find((c) => c.kind === "person" && c.id === focusedPerson)?.name ?? "") : "";
  const fmState = focusedPerson ? findMore[focusedPerson] : undefined;
  const fmBusy = fmState?.status === "pending" || fmState?.status === "running";

  const loadFindMore = useEffectEvent(async (personId: string) => {
    const seq = fmSeq.current;
    try {
      const res = await fetch(`/api/sessions/${session.id}/find-more?personId=${encodeURIComponent(personId)}`);
      if (!res.ok || seq !== fmSeq.current) return;
      const next = (await res.json()) as FindMoreState;
      const local = fmSeen.current[personId];
      if (next.status === "none" && (local === "pending" || local === "running")) return; // our own request isn't visible yet
      const was = fmSeen.current[personId];
      fmSeen.current[personId] = next.status;
      setFindMore((all) => ({ ...all, [personId]: next }));
      // A run that just finished brings new moments: re-read the page's data (this component keeps its state).
      if ((was === "pending" || was === "running") && next.status === "done") router.refresh();
    } catch {
      // a dropped poll: the next one retries
    }
  });
  // Opening a focused person shows a run already going (or done, or failed) for them.
  useEffect(() => {
    if (focusedPerson) void loadFindMore(focusedPerson);
  }, [focusedPerson]);
  useEffect(() => {
    if (!focusedPerson || !fmBusy) return;
    return startRefreshLoop(() => void loadFindMore(focusedPerson), FIND_MORE_POLL_MS);
  }, [focusedPerson, fmBusy]);

  async function startFindMore() {
    if (!focusedPerson || fmBusy) return;
    const personId = focusedPerson;
    fmSeen.current[personId] = "pending";
    fmSeq.current += 1;
    setFindMore((all) => ({ ...all, [personId]: { status: "pending", momentCount: 0, error: null } }));
    try {
      const res = await fetch(`/api/sessions/${session.id}/find-more`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      if (res.ok || res.status === 409) return; // 409: one is already running; the poll follows it
      const error = await errorMessage(res, t("briefing.findMoreFailed"));
      setFindMore((all) => ({ ...all, [personId]: { status: "failed", momentCount: 0, error } }));
    } catch {
      setFindMore((all) => ({ ...all, [personId]: { status: "failed", momentCount: 0, error: t("briefing.findMoreFailed") } }));
    }
  }
  // "Found N moments with X." plus how many are at the other levels (the list shows one level at a time).
  const otherLevels = (["exchange", "passage", "punchline"] as const).filter((g) => g !== filters.granularity);
  const hiddenFoundAll = fmState?.requestId
    ? moments.filter((m) => m.origin === "find_more" && m.findMoreRequestId === fmState.requestId && m.granularity !== filters.granularity && statuses[m.id] !== "approved").length
    : 0;
  const hiddenFound = Math.min(hiddenFoundAll, fmState?.momentCount ?? 0); // kept earlier moments aren't new
  const findMoreSummary =
    (fmState?.momentCount === 1 ? t("briefing.findMoreFoundOne", { name: personName }) : t("briefing.findMoreFound", { n: fmState?.momentCount ?? 0, name: personName })) +
    (hiddenFound === 0
      ? ""
      : t(hiddenFound === 1 ? "briefing.findMoreOtherLevelsOne" : "briefing.findMoreOtherLevels", { m: hiddenFound, levels: otherLevels.map((g) => t(`granularity.${g}`)).join(" or ") }));
  const findMoreLabel = fmBusy ? t("briefing.finding") : t("briefing.findMore", { name: personName });

  function setStatus(id: string, status: SelectionStatus | null) {
    queue.set(id, asClipStatus(status), asClipStatus(statuses[id] ?? null));
    setAnnouncement(t(status ? ANNOUNCE[status] : "briefing.announceUndecided", { title: titleOf.get(id) ?? "" }));
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

  const ctx: RowContext = {
    sessionId: session.id,
    language: lang,
    hasVideo: session.hasVideo,
    videoRemoved: session.videoRemoved,
    playingId: playing,
    excerpts,
    names,
    voices,
    sensitive,
    errors,
    // Clicking the active status returns the moment to undecided.
    onStatus: (id, clicked) => setStatus(id, nextStatus(statuses[id] ?? null, clicked)),
    onPlay: (id) => setPlaying((p) => (p === id ? null : id)),
  };
  const isDefault = toSearchParams(filters) === "";
  const shown = order.length;
  // "Fewer than 5 moments at the selected granularity": finer moments nested under a row don't count.
  const atLevel = (function count(list: typeof views): number {
    return list.reduce((n, v) => n + (v.moment.granularity === filters.granularity ? 1 : 0) + count(v.children), 0);
  })(views);
  const confirmDisabled = approved.length === 0 || busy !== null || session.videoRemoved;

  return (
    <>
      <AppBar current="Briefing" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6">
        <header className="mb-3">
          <Link href={`/s/${session.id}`} className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand">
            {t("briefing.backToPreview")}
          </Link>
          <div className="mt-1 flex items-start justify-between gap-3">
            <h1 lang={lang} dir="auto" className="min-w-0 text-xl font-bold tracking-tight break-words">
              {session.title}
            </h1>
            <div className="flex shrink-0 items-center gap-2">
              <Button ref={whoRef} variant="outline" onClick={() => setWhoOpen(true)}>
                {t("names.whoOpen")}
              </Button>
              <AskDrawer sessionId={session.id} language={session.language} hasVideo={session.hasVideo} videoRemoved={session.videoRemoved} />
            </div>
          </div>
          <WhosWhoDrawer
            open={whoOpen}
            onOpenChange={setWhoOpen}
            finalFocus={whoRef}
            sessionId={session.id}
            rows={whoRows}
            names={names}
            sensitive={sensitive}
            profile={profile}
            language={lang}
            videoRemoved={session.videoRemoved}
          />
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
        {namesChanged && (
          <p role="status" className={`${NOTICE} border-border bg-white text-foreground`}>
            {t("names.changedNotice")}{" "}
            <Link href={`/s/${session.id}?reanalyze=1`} className="font-medium underline underline-offset-2">
              {t("names.reanalyse")}
            </Link>
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
            <Controls
              filters={filters}
              onChange={setFilters}
              choices={choices}
              types={types}
              findMore={focusedPerson && personName ? { label: findMoreLabel, busy: fmBusy, onClick: () => void startFindMore() } : null}
            />
            {fmState?.status === "failed" && fmState.error && (
              <p role="alert" className="mb-2 text-xs text-red-700">
                {fmState.error}
              </p>
            )}
            {fmState?.status === "done" && (
              <p role="status" className="mb-2 text-xs text-muted-foreground">
                {fmState.momentCount === 0 ? t("briefing.findMoreNone") : findMoreSummary}
              </p>
            )}

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

            {focusedPerson && personName && atLevel < 5 && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  disabled={fmBusy}
                  onClick={() => void startFindMore()}
                  className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-4 text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Busy busy={fmBusy}>{findMoreLabel}</Busy>
                </button>
              </div>
            )}
          </>
        )}

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
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
                  <Busy busy={busy === "confirm"}>{busy === "confirm" ? t("briefing.confirmBusy") : t("briefing.confirm")}</Busy>
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
