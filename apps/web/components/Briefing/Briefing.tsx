"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PROFILES, formatTimestamp, type ClipStatus, type Granularity, type SelectionStatus } from "@digestor/core";
import { AskDrawer } from "@/components/Ask/AskDrawer";
import { ContextBanner } from "@/components/ContextBanner";
import { previewTargets } from "@/components/ReportProblem";
import { WhosWhoDrawer } from "@/components/Names/WhosWho";
import { WARNING_BOX, WarningIcon } from "@/components/WarningNote";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Busy } from "@/components/ui/spinner";
import {
  SHOW_HIDDEN_FILTERS, filterMoments, fromSearchParams, groupByTopic, hiddenApprovedCount, toSearchParams,
  type BriefingFilters,
} from "@/lib/briefingFilters";
import { errorMessage } from "@/lib/http";
import { buildSections, topicIdOf } from "@/lib/preview";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { approvedMomentIds, asClipStatus, asSelection, flattenViews, nextStatus } from "@/lib/review";
import { StatusQueue } from "@/lib/statusQueue";
import { useBriefingTranslation } from "@/lib/useBriefingTranslation";
import { useFindMore } from "@/lib/useFindMore";
import { languageName, t, type MessageKey } from "@/lib/i18n";
import type { BriefingProps } from "@/lib/briefingPage";
import { Controls } from "./Controls";
import { DocActions } from "./DocActions";
import type { RowContext } from "./MomentRow";
import { SomethingOff } from "./SomethingOff";
import { SummaryCard } from "./SummaryCard";
import { TopicCard } from "./TopicCard";

const NOTICE = "mb-3 rounded-xl border px-3 py-2 text-sm";
const ANNOUNCE: Record<SelectionStatus, MessageKey> = { approved: "briefing.announceApproved", rejected: "briefing.announceSkipped" };
const LEVELS: Granularity[] = ["exchange", "passage", "punchline"];
/** While a re-analysis runs, re-read the page this often so the new version replaces the old one when it lands. */
const RUNNING_REFRESH_MS = 5000;
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Persists one selection; throws with the API's sentence on failure. */
async function sendSelection(id: string, status: ClipStatus): Promise<void> {
  const res = await fetch(`/api/moments/${id}/selection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: asSelection(status) }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, t("briefing.saveFailed")));
}

/**
 * The Briefing page (render it with `key={analysis.id}` so a new analysis version starts with fresh state): header and
 * notices, the summary card (lead, timeline, top highlights, document actions, "Something's off"), the filters (kept
 * in the URL), one card per topic with its moment tree and Approve / Skip, and the sticky "Prepare clips" bar.
 */
export function Briefing(props: BriefingProps) {
  const { session, analysis, names, voices, topics, moments, choices, selections } = props;
  const router = useRouter();
  const searchParams = useSearchParams();
  const lang = session.language ?? undefined;
  const sensitive = PROFILES[analysis.profile].sensitive;
  const official = useMemo(() => moments.filter((m) => m.ownerId === null), [moments]);
  const sections = useMemo(() => buildSections(topics, official, props.briefing), [topics, official, props.briefing]);
  const targets = useMemo(() => previewTargets(analysis.id, sections, official), [analysis.id, sections, official]);
  const tr = useBriefingTranslation(analysis.id);

  const [filters, setFiltersState] = useState<BriefingFilters>(() =>
    fromSearchParams(searchParams, {
      speakers: choices.filter((c) => c.kind === "voice").map((c) => c.id),
      persons: choices.filter((c) => c.kind === "person").map((c) => c.id),
    }),
  );
  // Rows decided during this visit stay where they are (dimmed when skipped) until the filters change.
  const [sticky, setSticky] = useState<ReadonlySet<string>>(() => new Set());
  const setFilters = (next: BriefingFilters) => {
    setFiltersState(next);
    setSticky(new Set());
  };
  const [statuses, setStatuses] = useState<Record<string, SelectionStatus>>(selections);
  const [playing, setPlaying] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reanalyzeOpen, setReanalyzeOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  const metaWhoRef = useRef<HTMLButtonElement>(null);
  const whoRef = useRef<HTMLButtonElement>(null);
  const [whoFrom, setWhoFrom] = useState<"meta" | "button">("button");
  const [active, setActive] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

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

  // Re-analysing: refresh the server data until the running version is gone (the page keys <Briefing> on the analysis id).
  useEffect(() => {
    if (!analysis.running) return;
    return startRefreshLoop(() => router.refresh(), RUNNING_REFRESH_MS);
  }, [analysis.running, router]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  // Next can keep this page (and its state) alive after navigating away: re-enable the button for when it comes back.

  // Who speaks in each moment came from the server (it holds the words), so the person filter stays instant.
  const focusCtx = useMemo(() => ({ peopleByMoment: new Map(Object.entries(props.people).map(([id, ids]) => [id, new Set(ids)])) }), [props.people]);
  const views = useMemo(() => filterMoments(moments, statuses, filters, topics, focusCtx, sticky), [moments, statuses, filters, topics, focusCtx, sticky]);
  const groups = useMemo(() => groupByTopic(views, topics), [views, topics]);
  const shown = useMemo(() => flattenViews(views).length, [views]);
  const titleOf = useMemo(() => new Map(moments.map((m) => [m.id, m.title])), [moments]);
  const approved = useMemo(() => approvedMomentIds(moments, statuses), [moments, statuses]);
  const approvedSet = useMemo(() => new Set(approved), [approved]);
  const hiddenApproved = useMemo(() => hiddenApprovedCount(views, approved), [views, approved]);
  const levelCounts = useMemo(
    () => Object.fromEntries(LEVELS.map((g) => [g, moments.filter((m) => m.granularity === g).length])) as Record<Granularity, number>,
    [moments],
  );
  const isDefault = toSearchParams(filters) === "";

  const fm = useFindMore({ sessionId: session.id, filters, choices, moments, statuses, onDone: () => router.refresh() });

  function setStatus(id: string, clicked: SelectionStatus) {
    const next = nextStatus(statuses[id] ?? null, clicked);
    queue.set(id, asClipStatus(next), asClipStatus(statuses[id] ?? null));
    setSticky((s) => (s.has(id) ? s : new Set(s).add(id)));
    setAnnouncement(t(next ? ANNOUNCE[next] : "briefing.announceUndecided", { title: titleOf.get(id) ?? "" }));
  }

  /** Runs inside the ConfirmDialog: throws a friendly message to keep it open with the error shown. */
  async function confirm() {
    const momentIds = approved; // the optimistic statuses: what the queue is about to have saved
    // Confirm exactly what was approved: let in-flight selection changes land first.
    const { failed } = await queue.idle();
    if (failed) throw new Error(t("briefing.someFailed"));
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${session.id}/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentIds }),
      });
    } catch {
      throw new Error(t("briefing.confirmFailed"));
    }
    if (!res.ok) throw new Error(await errorMessage(res, t("briefing.confirmFailed")));
    router.push(`/s/${session.id}/prepare`);
  }

  function scrollTo(el: Element | null | undefined, block: ScrollLogicalPosition) {
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block });
  }
  function goToTopic(topicId: string) {
    setActive(topicId);
    scrollTo(document.getElementById(`topic-${topicId}`), "start");
  }
  // A pin or top-highlight card: the moment's row when the filters show it, else its topic's card.
  function goToMoment(momentId: string) {
    const m = moments.find((x) => x.id === momentId);
    const topicId = m ? topicIdOf(m, topics) : null;
    if (topicId) setActive(topicId);
    const row = document.getElementById(`moment-${momentId}`);
    scrollTo(row ?? (topicId ? document.getElementById(`topic-${topicId}`) : null), row ? "center" : "start");
    if (row) setFlash(momentId);
  }

  const ctx: RowContext = {
    sessionId: session.id,
    language: lang,
    hasVideo: session.hasVideo,
    videoRemoved: session.videoRemoved,
    playingId: playing,
    flashId: flash,
    excerpts: props.excerpts,
    names,
    voices,
    sensitive,
    errors,
    approvedIds: approvedSet,
    views,
    onStatus: setStatus,
    onPlay: (id) => setPlaying((p) => (p === id ? null : id)),
  };
  const byTopic = new Map(groups.map((g) => [g.topic?.id ?? null, g.views]));
  const outside = byTopic.get(null) ?? [];

  const speakersText = props.speakers === 1 ? t("preview.speakersOne") : t("preview.speakersMany", { n: props.speakers });
  const namedText = t("preview.namedCount", { named: props.named });
  const openWho = (from: "meta" | "button") => {
    setWhoFrom(from);
    setWhoOpen(true);
  };
  const meta = [
    session.durationMs > 0 ? formatTimestamp(session.durationMs) : null,
    props.speakers > 0 ? (
      <button
        key="who"
        ref={metaWhoRef}
        type="button"
        aria-label={t("names.whoOpenFromCount", { text: `${speakersText}, ${namedText}` })}
        onClick={() => openWho("meta")}
        className="rounded-sm underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
      >
        {speakersText} · {namedText}
      </button>
    ) : null,
    session.language ? languageName(session.language) : null,
    t(`profile.${analysis.profile}`),
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <>
      {props.card && <ContextBanner sessionId={session.id} card={props.card} />}

      <header className="mb-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h1 lang={lang} dir="auto" className="min-w-0 basis-full text-xl font-bold tracking-tight break-words sm:flex-1 sm:basis-0">
            {session.title}
          </h1>
          <div className="flex items-center gap-2">
            <Button ref={whoRef} variant="outline" size="sm" onClick={() => openWho("button")}>
              {t("names.whoOpen")}
            </Button>
            <AskDrawer sessionId={session.id} language={session.language} hasVideo={session.hasVideo} videoRemoved={session.videoRemoved} />
          </div>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-muted-foreground">
          {meta.map((m, i) => (
            <span key={i} className="after:ml-1.5 after:content-['·']">
              {m}
            </span>
          ))}
          {analysis.note ? (
            <span tabIndex={0} title={analysis.note} className="cursor-help underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand">
              {t("preview.analysisVersion", { n: analysis.version })}
              <span className="sr-only">. {analysis.note}</span>
            </span>
          ) : (
            <span>{t("preview.analysisVersion", { n: analysis.version })}</span>
          )}
        </p>
      </header>

      {analysis.running && (
        <p role="status" className={`${NOTICE} border-border bg-white text-foreground`}>
          {t("preview.running")}
        </p>
      )}
      {analysis.failedVersion !== null && !analysis.running && (
        <p role="alert" className={`${NOTICE} border-border bg-white text-red-700`}>
          {t("preview.rerunFailed")}
        </p>
      )}
      {props.namesChanged && (
        <p role="status" className={`${NOTICE} border-border bg-white text-foreground`}>
          {t("names.changedNotice")}{" "}
          <button type="button" onClick={() => setReanalyzeOpen(true)} className="font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand">
            {t("names.reanalyse")}
          </button>
        </p>
      )}
      {session.videoRemoved && (
        <p id="video-removed" role="status" className={`${NOTICE} border-border bg-stone-100 text-stone-800`}>
          {t("preview.videoRemoved")}
        </p>
      )}
      {sensitive && (
        <p role="note" className={`${NOTICE} flex items-start gap-2 ${WARNING_BOX}`}>
          <WarningIcon className="mt-0.5" />
          <span>{t("preview.sensitive")}</span>
        </p>
      )}
      {props.earlier && (
        <p role="status" className={`${NOTICE} border-border bg-white text-foreground`}>
          {props.earlier.count === 1
            ? t("briefing.earlierOne", { version: props.earlier.version })
            : t("briefing.earlierMany", { n: props.earlier.count, version: props.earlier.version })}
        </p>
      )}

      <SummaryCard
        durationMs={session.durationMs}
        language={lang}
        profile={analysis.profile}
        briefing={props.briefing}
        topics={topics}
        moments={official}
        names={names}
        voices={voices}
        sensitive={sensitive}
        tr={tr}
        activeTopicId={active}
        onMoment={goToMoment}
        onTopic={goToTopic}
        actions={
          <>
            <DocActions title={session.title} durationMs={session.durationMs} language={session.language} briefing={props.briefing} topics={topics} moments={official} tr={tr} />
            <SomethingOff
              sessionId={session.id}
              profile={analysis.profile}
              targets={targets}
              reanalyzeOpen={reanalyzeOpen}
              onReanalyzeOpenChange={setReanalyzeOpen}
              onStarted={() => router.refresh()}
            />
          </>
        }
      />

      {moments.length === 0 ? (
        <p className="mb-4 rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">{t("briefing.none")}</p>
      ) : (
        <Controls
          filters={filters}
          onChange={setFilters}
          choices={choices}
          types={props.types}
          levelCounts={levelCounts}
          shown={shown}
          findMore={fm.offer ? { label: fm.label, busy: fm.busy, onClick: fm.start, error: fm.error, summary: fm.summary } : null}
        />
      )}

      <div className="grid gap-3">
        {sections.map((s) => (
          <TopicCard key={s.topic.id} section={s} translated={tr.translated} trLang={tr.lang} views={byTopic.get(s.topic.id) ?? []} ctx={ctx} emptyNote={moments.length > 0 && !isDefault} />
        ))}
        {outside.length > 0 && <TopicCard section={null} translated={null} trLang={undefined} views={outside} ctx={ctx} emptyNote={false} />}
      </div>

      {fm.offer && fm.fewAtLevel(views) && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={fm.busy}
            onClick={fm.start}
            className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-4 text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Busy busy={fm.busy}>{fm.label}</Busy>
          </button>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
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
              disabled={approved.length === 0 || session.videoRemoved}
              onClick={() => setConfirmOpen(true)}
              aria-describedby={session.videoRemoved ? "video-removed" : undefined}
              className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground"
            >
              {t("briefing.confirm")}
            </button>
          </span>
        </div>
      </footer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("briefing.confirmTitle")}
        description={approved.length === 1 ? t("briefing.confirmDescriptionOne") : t("briefing.confirmDescription", { n: approved.length })}
        actionLabel={t("briefing.confirmAction")}
        busyLabel={t("briefing.confirmBusy")}
        onConfirm={confirm}
      />

      <WhosWhoDrawer
        open={whoOpen}
        onOpenChange={setWhoOpen}
        finalFocus={whoFrom === "meta" ? metaWhoRef : whoRef}
        sessionId={session.id}
        rows={props.whoRows}
        names={names}
        sensitive={sensitive}
        profile={analysis.profile}
        language={lang}
        videoRemoved={session.videoRemoved}
      />
    </>
  );
}
