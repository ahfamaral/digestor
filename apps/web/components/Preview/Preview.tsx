"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  PROFILES, formatTimestamp, topHighlights, type BriefingContent, type ContextCard, type MomentWithHighlights,
  type ProfileId, type Topic,
} from "@digestor/core";
import { AskDrawer } from "@/components/Ask/AskDrawer";
import { WARNING_BOX, WarningIcon } from "@/components/WarningNote";
import { ContextBanner } from "@/components/ContextBanner";
import { ReportProblem, previewTargets } from "@/components/ReportProblem";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/http";
import { WhosWhoDrawer } from "@/components/Names/WhosWho";
import type { NamesData, Voice, WhosWhoRow } from "@/lib/names";
import { voiceLabel } from "@/lib/names";
import { buildSections, mostDiscussedCard } from "@/lib/preview";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { buildTimeline } from "@/lib/timeline";
import { languageName, t } from "@/lib/i18n";
import { BriefingDoc } from "./BriefingDoc";
import { Timeline } from "./Timeline";
import { TopHighlights } from "./TopHighlights";

export interface PreviewProps {
  session: { id: string; title: string; durationMs: number; language: string | null; hasVideo: boolean; videoRemoved: boolean };
  analysis: {
    id: string;
    version: number;
    profile: ProfileId;
    note: string | null;
    running: boolean;
    /** Number of a newer version that failed (its results never replaced these), or null. */
    failedVersion: number | null;
  };
  speakers: number;
  /** How many of the speakers have a name to show. */
  named: number;
  names: NamesData;
  /** Who's who rows (voice and name, longest first). */
  whoRows: WhosWhoRow[];
  /** Who to show per moment id. */
  voices: Record<string, Voice[]>;
  topics: Topic[];
  moments: MomentWithHighlights[];
  briefing: BriefingContent | null;
  card: ContextCard | null;
}

const NOTICE = "mb-3 rounded-xl border px-3 py-2 text-sm";
/** Ignore the scroll observer this long after a click, so a smooth scroll doesn't drag the dark band through other topics. */
const CLICK_LOCK_MS = 1200;
/** Height the sticky timeline covers at the top of the viewport; sections under it don't count as being read. */
const STICKY_TIMELINE_PX = 120;
/** While a re-analysis runs, re-read the page this often so the new version replaces the old one when it lands. */
const RUNNING_REFRESH_MS = 5000;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Preview, the proof step (render it with `key={analysis.id}` so a new analysis version starts with fresh state): header, session timeline, top highlight cards and the grounded briefing, with
 * "Looks right → Full briefing" and "Something's off" (re-run with another profile, or report a problem).
 */
export function Preview({ session, analysis, speakers, named, names, whoRows, voices, topics, moments, briefing, card }: PreviewProps) {
  const router = useRouter();
  const lang = session.language ?? undefined;
  const sensitive = PROFILES[analysis.profile].sensitive;
  const sections = useMemo(() => buildSections(topics, moments, briefing, analysis.profile), [topics, moments, briefing, analysis.profile]);
  const top = useMemo(() => topHighlights(moments, analysis.profile), [moments, analysis.profile]);
  const mostDiscussed = useMemo(() => mostDiscussedCard(topics), [topics]);
  const timeline = useMemo(() => {
    const { bands, pins } = buildTimeline(topics, top, session.durationMs);
    const byId = new Map(moments.map((m) => [m.id, m]));
    const startOf = new Map(topics.map((tp) => [tp.id, tp.startMs]));
    return {
      bands: bands.map((b) => ({ ...b, startMs: startOf.get(b.topicId) ?? 0 })),
      pins: pins.map((p) => ({
        ...p,
        title: byId.get(p.momentId)?.title ?? "",
        startMs: byId.get(p.momentId)?.startMs ?? 0,
        people: (voices[p.momentId] ?? []).map((v) => voiceLabel(names, v.speakerId, v.atMs, sensitive).text),
      })),
    };
  }, [topics, top, moments, session.durationMs, voices, names, sensitive]);
  const topicOfMoment = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sections) for (const m of s.rows) map.set(m.id, s.topic.id);
    for (const m of moments) if (!map.has(m.id) && m.topicId) map.set(m.id, m.topicId);
    return map;
  }, [sections, moments]);

  // Re-analysing: refresh the server data until the running version is gone (the page keys <Preview> on the
  // analysis id, so a new version starts with fresh state).
  useEffect(() => {
    if (!analysis.running) return;
    return startRefreshLoop(() => router.refresh(), RUNNING_REFRESH_MS);
  }, [analysis.running, router]);

  const [active, setActive] = useState<string | null>(topics[0]?.id ?? null);
  const [flash, setFlash] = useState<string | null>(null);
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const lockUntil = useRef(0);
  const sectionRef = useCallback((topicId: string, el: HTMLElement | null) => {
    if (el) sectionEls.current.set(topicId, el);
    else sectionEls.current.delete(topicId);
  }, []);

  // The dark band follows the topmost section in view.
  useEffect(() => {
    const visible = new Set<string>();
    const order = topics.map((tp) => tp.id);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.topicId;
          if (!id) continue;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        if (Date.now() < lockUntil.current) return;
        const topmost = order.find((id) => visible.has(id));
        if (topmost) setActive(topmost);
      },
      { rootMargin: `-${STICKY_TIMELINE_PX}px 0px 0px 0px` },
    );
    for (const el of sectionEls.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [topics]);

  function scrollTo(el: Element | null | undefined, block: ScrollLogicalPosition) {
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block });
  }
  function goToTopic(topicId: string) {
    lockUntil.current = Date.now() + CLICK_LOCK_MS;
    setActive(topicId);
    scrollTo(sectionEls.current.get(topicId), "start");
  }
  function goToMoment(momentId: string) {
    const topicId = topicOfMoment.get(momentId);
    lockUntil.current = Date.now() + CLICK_LOCK_MS;
    if (topicId) setActive(topicId);
    const row = document.getElementById(`moment-${momentId}`);
    scrollTo(row ?? (topicId ? sectionEls.current.get(topicId) : null), row ? "center" : "start");
    setFlash(momentId);
  }
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  const [offOpen, setOffOpen] = useState(false);
  const [reanalyzeOpen, setReanalyzeOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const targets = useMemo(() => previewTargets(analysis.id, sections), [analysis.id, sections]);

  const [whoOpen, setWhoOpen] = useState(false);
  const whoRef = useRef<HTMLButtonElement>(null);
  const speakersText = speakers === 1 ? t("preview.speakersOne") : t("preview.speakersMany", { n: speakers });
  const namedText = t("preview.namedCount", { named });
  const meta = [
    session.durationMs > 0 ? formatTimestamp(session.durationMs) : null,
    speakers > 0 ? (
      <button
        key="who"
        ref={whoRef}
        type="button"
        aria-label={t("names.whoOpenFromCount", { text: `${speakersText}, ${namedText}` })}
        onClick={() => setWhoOpen(true)}
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
      {card && <ContextBanner sessionId={session.id} card={card} />}

      <header className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <h1 lang={lang} dir="auto" className="min-w-0 text-xl font-bold tracking-tight break-words">
            {session.title}
          </h1>
          <AskDrawer sessionId={session.id} language={session.language} hasVideo={session.hasVideo} videoRemoved={session.videoRemoved} />
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
      {session.videoRemoved && (
        <p id="video-removed" role="status" className={`${NOTICE} border-border bg-stone-100 text-stone-800`}>
          {t("preview.videoRemoved")}
        </p>
      )}
      {PROFILES[analysis.profile].sensitive && (
        <p role="note" className={`${NOTICE} flex items-start gap-2 ${WARNING_BOX}`}>
          <WarningIcon className="mt-0.5" />
          <span>{t("preview.sensitive")}</span>
        </p>
      )}

      <Timeline
        bands={timeline.bands}
        pins={timeline.pins}
        durationMs={session.durationMs}
        activeTopicId={active}
        onBand={goToTopic}
        onPin={goToMoment}
      />
      <TopHighlights top={top} names={names} voices={voices} sensitive={sensitive} mostDiscussed={mostDiscussed} language={lang} onMoment={goToMoment} onTopic={goToTopic} />

      <BriefingDoc
        sessionId={session.id}
        analysisId={analysis.id}
        title={session.title}
        durationMs={session.durationMs}
        language={session.language}
        hasVideo={session.hasVideo}
        videoRemoved={session.videoRemoved}
        briefing={briefing}
        topics={topics}
        moments={moments}
        sections={sections}
        names={names}
        voices={voices}
        sensitive={sensitive}
        activeTopicId={active}
        flashMomentId={flash}
        sectionRef={sectionRef}
      />

      <div className="mt-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" aria-expanded={offOpen} aria-controls="something-off" onClick={() => setOffOpen((o) => !o)}>
            {t("preview.somethingOff")}
          </Button>
          <Link
            href={`/s/${session.id}/briefing`}
            className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          >
            {t("preview.looksRight")}
          </Link>
        </div>
        {offOpen && (
          <div id="something-off" className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setReanalyzeOpen(true)}>
              {t("preview.backToContext")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
              {t("preview.reportProblem")}
            </Button>
          </div>
        )}
        {reportSent && (
          <p role="status" className="text-right text-xs text-emerald-700">
            {t("preview.reportSent")}{" "}
            <Link href="/reports" className="underline underline-offset-2">
              {t("preview.reportsLink")}
            </Link>
          </p>
        )}
      </div>

      <WhosWhoDrawer
        open={whoOpen}
        onOpenChange={setWhoOpen}
        finalFocus={whoRef}
        sessionId={session.id}
        rows={whoRows}
        names={names}
        sensitive={sensitive}
        language={lang}
      />
      <ReanalyzeDialog
        open={reanalyzeOpen}
        onOpenChange={setReanalyzeOpen}
        sessionId={session.id}
        current={analysis.profile}
        onStarted={() => {
          setOffOpen(false);
          router.refresh();
        }}
      />
      <ReportProblem
        open={reportOpen}
        onOpenChange={setReportOpen}
        sessionId={session.id}
        targets={targets}
        onSent={() => {
          setOffOpen(false);
          setReportSent(true);
        }}
      />
    </>
  );
}

/** "Back to context check": choose the profile and confirm a new AI pass (POST reanalyze). */
function ReanalyzeDialog({
  open,
  onOpenChange,
  sessionId,
  current,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  current: ProfileId;
  onStarted: () => void;
}) {
  const [profile, setProfile] = useState<ProfileId>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, t("preview.errorGeneric")));
      close();
      onStarted();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("preview.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setProfile(current);
    setError(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={confirm} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>{t("preview.backToContext")}</DialogTitle>
            <DialogDescription>{t("preview.reanalyzeBody")}</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {t("preview.reanalyzeProfile")}
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value as ProfileId)}
              className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {(Object.keys(PROFILES) as ProfileId[]).map((id) => (
                <option key={id} value={id}>
                  {t(`profile.${id}`)}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("preview.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("preview.reanalyzeBusy") : t("preview.reanalyzeConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
