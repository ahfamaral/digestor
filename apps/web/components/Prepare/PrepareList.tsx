"use client";

import { MediaPlayer } from "@/components/MediaPlayer";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  PROFILES, checksForClip, exportChecklist, formatLength, formatTimestamp, speakersInRange, type ClipFormat, type MomentChecks, type ProfileId, type Range,
} from "@digestor/core";
import { SpeakerName, SpeakerSep } from "@/components/Names/SpeakerName";
import { unconfirmedAcrossClips, type NamesData, type Voice, type WhosWhoRow } from "@/lib/names";
import { UnconfirmedBanner } from "@/components/Names/UnconfirmedBanner";
import { AppBar } from "@/components/AppBar";
import { BackLink } from "@/components/BackLink";
import { isExportReady } from "@/lib/exportRows";
import { debouncedCommit } from "@/lib/debouncedCommit";
import { addTrack, fetchChecks, fetchTracks, mergeClipsApi, patchClip, requestChecks, undoClip, type ClipChange } from "@/lib/prepareApi";
import { checksToPoll, clipStatus, withOpen, insideClip, mergePairs, sharedValue, type ClipStatus, type ClipView, type TrackView, type UndoStep } from "@/lib/prepareData";
import { runForAll } from "@/lib/forAllRun";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ApprovalDismissed } from "@/components/ApprovalDismissed";
import { ChecksPanel } from "./ChecksPanel";
import { Checklist } from "./Checklist";
import { ClipIndex } from "./ClipIndex";
import { ClipStatusBadge } from "./ClipStatusBadge";
import { ChevronRightIcon } from "lucide-react";
import { FormatPicker, cropPosition } from "./FormatPicker";
import { ForAllClips, type ForAllRun } from "./ForAllClips";
import { SubtitlesPanel } from "./SubtitlesPanel";
import { TrimStrip } from "./TrimStrip";
import { Busy } from "@/components/ui/spinner";
import { HasVideoProvider } from "@/components/HasVideo";

/** One clip as the server page sends it. */
export interface PrepareClipData {
  clip: ClipView;
  /** The clip's moment title (in the spoken language). */
  title: string;
  /** The moment's checks (they count for this clip only while it has the moment's bounds, R28). */
  checks: MomentChecks | null;
  /** The moment's bounds; null when the clip has no moment. */
  momentRange: Range | null;
  tracks: TrackView[];
  /** Cut positions inside the trim window (clip ± 30 s), computed server-side from the transcript. */
  points: { starts: number[]; ends: number[] };
  /** What Undo would revert (null: nothing). */
  undo: UndoStep | null;
  /** Who speaks in the clip's current range (longest first). */
  voices: Voice[];
  /** Who speaks where in the trim window (clip ± 30 s), the least the speaker check needs to follow a trim. */
  speakerWords: { startMs: number; endMs: number; speaker: string }[];
  thumbUrl: string | null;
  /** The clip's moment is no longer approved on the Briefing. */
  dismissed: boolean;
  /** How many moments the clip covers (more than one after a merge). */
  mergedCount: number;
}

export interface PrepareListProps {
  session: {
    id: string;
    title: string;
    language: string | null;
    durationMs: number;
    hasVideo: boolean;
    videoRemoved: boolean;
    profile: ProfileId;
  };
  /** The credit a clip starts with (YouTube channel), or "" for uploads. */
  defaultCredit: string;
  names: NamesData;
  /** Who's who rows of the whole session (the banner's "Confirm names" opens them). */
  whoRows: WhosWhoRow[];
  clips: PrepareClipData[];
}

const POLL_MS = 3000;
/** Ruling R11: checks still null after this long couldn't run. */
const CHECKS_TIMEOUT_MS = 60_000;
/** The crop slider saves this long after its last movement. */
const CROP_COMMIT_MS = 400;
const NOTICE = "mb-3 rounded-xl border px-3 py-2 text-sm";

type Item = PrepareClipData;

/**
 * Server data after a refresh replaces local state, except a clip the user changed more recently than the server's
 * copy, checks the server doesn't have yet, and tracks it hasn't seen (added while the refresh was in flight).
 */
function merge(local: Item[], server: Item[]): Item[] {
  const byId = new Map(local.map((i) => [i.clip.id, i]));
  return server.map((s) => {
    const l = byId.get(s.clip.id);
    if (!l) return s;
    const tracks = [...s.tracks];
    for (const tr of l.tracks) if (!tracks.some((x) => x.id === tr.id)) tracks.push(tr);
    return {
      ...s,
      clip: l.clip.updatedAt > s.clip.updatedAt ? l.clip : s.clip,
      checks: s.checks ?? l.checks,
      tracks: tracks.sort((a, b) => a.language.localeCompare(b.language)),
    };
  });
}

/** The step a saved change adds to the clip's undo history (null: the change isn't undoable, the step stays). */
function undoAfter(body: ClipChange): UndoStep | null {
  if ("start" in body || "extend" in body) return { kind: "bounds" };
  if ("format" in body || "cropOffset" in body) return { kind: "format" };
  if ("subtitleStyle" in body || "subtitlePosition" in body) return { kind: "style" };
  return null;
}

/** The Undo button names what it reverts. */
function undoLabel(step: UndoStep | null): string {
  switch (step?.kind) {
    case "bounds":
      return t("prepare.undoBounds");
    case "format":
      return t("prepare.undoFormat");
    case "style":
      return t("prepare.undoStyle");
    case "merge":
      return t("prepare.undoMerge");
    default:
      return t("prepare.undo");
  }
}

/**
 * Prepare clips: one card per confirmed clip with the trim strip, checks, format, credit, subtitles and the
 * pre-export checklist, and "Export ready clips".
 */
export function PrepareList({ session, defaultCredit, names, whoRows, clips }: PrepareListProps) {
  const router = useRouter();
  const [seen, setSeen] = useState(clips);
  const [items, setItems] = useState(clips);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [timedOut, setTimedOut] = useState(false);
  /** Clips whose "Check again" restarted the minute of polling (R29). */
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const retryTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lang = session.language ?? undefined;

  // A router.refresh() brings new server data: fold it in (see merge).
  if (clips !== seen) {
    setSeen(clips);
    setItems((local) => merge(local, clips));
  }

  const update = (id: string, f: (i: Item) => Item) => setItems((all) => all.map((i) => (i.clip.id === id ? f(i) : i)));
  const setFor = (set: typeof setErrors, id: string, v: string | null) =>
    set((all) => {
      const next = { ...all };
      if (v === null) delete next[id];
      else next[id] = v;
      return next;
    });

  /** Saves one change; resolves false (with the error shown on the card) when it failed. */
  async function change(id: string, body: ClipChange, opts: { refresh?: boolean; announce?: boolean } = {}): Promise<boolean> {
    setFor(setErrors, id, null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const clip = await patchClip(id, body);
      update(id, (i) => ({ ...i, clip, undo: undoAfter(body) ?? i.undo }));
      if (opts.announce) {
        setFor(setStatuses, id, t("prepare.savedRange", { start: formatTimestamp(clip.startMs, { tenths: true }), end: formatTimestamp(clip.endMs, { tenths: true }) }));
      }
      // New bounds need the cut positions of the new window (and a fresh undo state) from the server.
      if (opts.refresh) router.refresh();
      // A look, format or crop change stales the made subtitle videos on the server: read the tracks again.
      if ("format" in body || "cropOffset" in body || "subtitleStyle" in body || "subtitlePosition" in body) {
        fetchTracks(id).then((tracks) => update(id, (i) => ({ ...i, tracks }))).catch(() => {});
      }
      setBusy((b) => ({ ...b, [id]: false }));
      return true;
    } catch (err) {
      setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy((b) => ({ ...b, [id]: false }));
    return false;
  }

  /** "For all clips": one change per clip, in order. A failure shows on that clip's card and the rest go on; resolves the failed ids. */
  async function runForAllClips(run: ForAllRun, progress: (done: number) => void): Promise<string[]> {
    const outcome = await runForAll(run.ids, async (id) => {
      if (run.kind === "language") {
        setFor(setErrors, id, null);
        try {
          setTrack(id, await addTrack(id, run.value));
          return true;
        } catch (err) {
          setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed"));
          return false;
        }
      }
      return change(id, run.kind === "credit" ? { credit: run.value === "" ? null : run.value } : { format: run.value });
    }, progress);
    return outcome.failed;
  }

  /** Cards the journalist opened or closed; a card without an entry is open unless it was ready when the page loaded. */
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});
  /** After a merge: the surviving card's heading takes focus once the absorbed card is gone. */
  const pendingFocus = useRef<{ id: string; gone: string | null } | null>(null);

  /** The two clip ids the open merge dialog is about (never an index: the list can change under it). */
  const [mergeIds, setMergeIds] = useState<[string, string] | null>(null);
  const pairs = session.videoRemoved ? new Map<number, number>() : mergePairs(items.map((i) => i.clip));
  const mergeAt = mergeIds ? items.findIndex((i) => i.clip.id === mergeIds[0]) : -1;
  const mergeA = mergeAt >= 0 ? items[mergeAt] : undefined;
  const mergeB = mergeIds ? items.find((i) => i.clip.id === mergeIds[1]) : undefined;
  const mergeBAt = mergeB ? items.indexOf(mergeB) : -1;
  // Either clip gone (a refresh, another tab): the dialog closes.
  if (mergeIds && (!mergeA || !mergeB)) setMergeIds(null);

  async function confirmMerge() {
    if (!mergeA || !mergeB) return;
    await mergeClipsApi([mergeA.clip.id, mergeB.clip.id]); // throws a friendly sentence; the dialog shows it
    // The earlier clip survives: say so in its status line (the pill and the absorbed card are about to go).
    setFor(setStatuses, mergeA.clip.id, t("prepare.merged", {
      a: mergeAt + 1,
      b: mergeBAt + 1,
      start: formatTimestamp(Math.min(mergeA.clip.startMs, mergeB.clip.startMs), { tenths: true }),
      end: formatTimestamp(Math.max(mergeA.clip.endMs, mergeB.clip.endMs), { tenths: true }),
    }));
    setMergeIds(null);
    setOpenOverride((o) => ({ ...o, [mergeA.clip.id]: true }));
    pendingFocus.current = { id: mergeA.clip.id, gone: mergeB.clip.id };
    router.refresh();
  }

  /** Reverts the clip's latest change; throws the friendly sentence when it failed. */
  async function runUndo(id: string) {
    setFor(setErrors, id, null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const clip = await undoClip(id);
      // The next step comes with the refresh; until then there is nothing known to undo.
      update(id, (i) => ({ ...i, clip, undo: null }));
      setFor(setStatuses, id, t("prepare.savedRange", { start: formatTimestamp(clip.startMs, { tenths: true }), end: formatTimestamp(clip.endMs, { tenths: true }) }));
      // The Undo button unmounts once there is nothing left to undo: focus goes to the clip heading, as after a merge.
      pendingFocus.current = { id, gone: null };
      router.refresh();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function undo(id: string) {
    try {
      await runUndo(id);
    } catch (err) {
      setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
  }

  /** The clip whose merge Undo would split again: asked first (it brings a clip back and outdates subtitles). */
  const [undoMergeId, setUndoMergeId] = useState<string | null>(null);
  const undoMergeItem = undoMergeId ? items.find((i) => i.clip.id === undoMergeId) : undefined;
  const undoMergeRange = undoMergeItem?.undo?.kind === "merge" ? undoMergeItem.undo.range : null;
  // The clip is gone or its next undo is no longer the merge (a refresh, another tab): the dialog closes.
  if (undoMergeId && !undoMergeRange) setUndoMergeId(null);

  const setTrack = (clipId: string, track: TrackView) =>
    update(clipId, (i) => {
      // A retried language comes back as a new track: it replaces the failed one.
      const others = i.tracks.filter((x) => x.id !== track.id && x.language !== track.language);
      return { ...i, tracks: [...others, track].sort((a, b) => a.language.localeCompare(b.language)) };
    });

  // The credit line starts from the YouTube channel: save it once for clips that have none yet.
  const creditApplied = useRef(false);
  useEffect(() => {
    if (creditApplied.current || defaultCredit === "" || session.videoRemoved) return;
    creditApplied.current = true;
    for (const i of clips) {
      if (i.clip.credit !== null || i.clip.noCreditNeeded) continue;
      const id = i.clip.id;
      patchClip(id, { credit: defaultCredit })
        .then((clip) => update(id, (x) => ({ ...x, clip })))
        .catch((err: unknown) => setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed")));
    }
    // Runs once, on the first data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ruling R11: after a minute, checks that are still null couldn't run.
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), CHECKS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => retryTimers.current.forEach(clearTimeout), []);

  /** "Check again": claims and sends a new check, then polls this clip for another minute. */
  async function checkAgain(id: string) {
    setFor(setErrors, id, null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await requestChecks(id);
      setRetrying((r) => ({ ...r, [id]: true }));
      retryTimers.current.push(setTimeout(() => setRetrying((r) => ({ ...r, [id]: false })), CHECKS_TIMEOUT_MS));
    } catch (err) {
      setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy((b) => ({ ...b, [id]: false }));
  }

  const pendingChecks = checksToPoll(items.map((i) => ({ id: i.clip.id, checks: i.checks })), timedOut, retrying).join(",");
  useEffect(() => {
    if (!pendingChecks) return;
    const ids = pendingChecks.split(",");
    return startRefreshLoop(() => {
      for (const id of ids) {
        fetchChecks(id)
          .then((checks) => checks && update(id, (i) => ({ ...i, checks })))
          .catch(() => {}); // polling: the next round tries again
      }
    }, POLL_MS);
  }, [pendingChecks]);

  const preparing = items.filter((i) => i.tracks.some((tr) => tr.status === "preparing")).map((i) => i.clip.id).join(",");
  useEffect(() => {
    if (!preparing) return;
    const ids = preparing.split(",");
    return startRefreshLoop(() => {
      for (const id of ids) {
        fetchTracks(id)
          .then((tracks) => update(id, (i) => ({ ...i, tracks })))
          .catch(() => {});
      }
    }, POLL_MS);
  }, [preparing]);

  const checklists = new Map(
    items.map((i) => [
      i.clip.id,
      exportChecklist({
        clip: i.clip,
        moment: i.momentRange ? { ...i.momentRange, checks: i.checks } : null,
        tracks: i.tracks.map((tr) => ({ status: tr.status, burnStatus: tr.burnStatus, approvedAt: tr.approved ? new Date(0) : null })),
        profile: session.profile,
        speakers: speakersInRange(i.speakerWords, names.attributions, i.clip),
      }),
    ]),
  );
  const sharedInput = items.map((i) => ({ id: i.clip.id, credit: i.clip.credit, format: i.clip.format, noCreditNeeded: i.clip.noCreditNeeded }));
  const creditDiffers = new Set(items.length > 1 ? sharedValue(sharedInput, "credit").differs : []);
  const formatDiffers = new Set(items.length > 1 ? sharedValue(sharedInput, "format").differs : []);
  const readyCount = items.filter((i) =>
    isExportReady({ dismissed: i.dismissed, failing: checklists.get(i.clip.id)!.filter((x) => !x.ok).map((x) => x.id) }),
  ).length;

  const unconfirmed = unconfirmedAcrossClips(
    items.map((i) => ({ startMs: i.clip.startMs, endMs: i.clip.endMs, words: i.speakerWords, dismissed: i.dismissed })),
    names,
    PROFILES[session.profile].sensitive,
  );
  const statusOf = (id: string): ClipStatus => clipStatus(checklists.get(id)!);
  // Ready cards start collapsed to one line; later readiness changes don't move cards under the journalist's hands.
  const [initiallyReady] = useState(() => new Set(items.filter((i) => statusOf(i.clip.id).ready && !i.dismissed).map((i) => i.clip.id)));
  const isOpen = (id: string) => openOverride[id] ?? !initiallyReady.has(id);
  const insideOf = insideClip(items.map((i) => i.clip));

  const focusHeading = (id: string, scroll: boolean) => {
    const h = document.getElementById(`clip-h-${id}`);
    if (!h) return;
    if (scroll) document.getElementById(`clip-${id}`)?.scrollIntoView({ block: "start" });
    h.focus({ preventScroll: true });
  };

  // `#clip-<id>` (an index link, or Export's "Fix in Prepare clips"): the hash never reaches the server, so read it here.
  // The card opens, then scrolls into view and its heading takes focus.
  const hashTarget = useRef<string | null>(null);
  useEffect(() => {
    const read = () => {
      const m = /^#clip-(.+)$/.exec(window.location.hash);
      if (!m) return;
      hashTarget.current = m[1]!;
      setOpenOverride((o) => withOpen(o, m[1]!));
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    const id = hashTarget.current;
    if (!id) return;
    hashTarget.current = null;
    requestAnimationFrame(() => focusHeading(id, true));
  });

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p || mergeIds || items.some((i) => i.clip.id === p.gone)) return;
    // Wait for the dialog to hand focus back before taking it.
    const timer = setTimeout(() => {
      pendingFocus.current = null;
      focusHeading(p.id, false);
    }, 200);
    return () => clearTimeout(timer);
  });

  return (
    <HasVideoProvider value={session.hasVideo}>
      <AppBar current="Prepare" session={{ id: session.id, ready: true }} facts={{ hasClips: items.length > 0, allReadyRendered: false }} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6">
        <header className="mb-3">
          <BackLink href={`/s/${session.id}`} label={t("prepare.backToBriefing")} />
          <h1 lang={lang} dir="auto" className="mt-1 text-xl font-bold tracking-tight break-words">
            {session.title}
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t("prepare.title")} · {items.length === 1 ? t("prepare.clipsOne") : t("prepare.clipsMany", { n: items.length })}
          </p>
        </header>

        {session.videoRemoved && (
          <p id="video-removed" role="status" className={`${NOTICE} border-border bg-stone-100 text-stone-800`}>
            {t("preview.videoRemoved")}
          </p>
        )}

        <UnconfirmedBanner
          sessionId={session.id}
          unconfirmed={unconfirmed}
          rows={whoRows}
          names={names}
          sensitive={PROFILES[session.profile].sensitive}
          profile={session.profile}
          language={lang}
          videoRemoved={session.videoRemoved}
        />

        {items.length > 1 && !session.videoRemoved && (
          <ForAllClips
            clips={items.map((i) => ({
              id: i.clip.id,
              credit: i.clip.credit,
              format: i.clip.format,
              noCreditNeeded: i.clip.noCreditNeeded,
              languages: i.tracks.map((tr) => tr.language),
              frozen: session.videoRemoved,
            }))}
            originalLanguage={session.language}
            onRun={runForAllClips}
          />
        )}

        {items.length === 0 ? (
          <div className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
            <p>{t("prepare.noClips")}</p>
            <Link href={`/s/${session.id}`} className="mt-2 inline-block text-foreground underline underline-offset-2">
              {t("prepare.openBriefing")}
            </Link>
          </div>
        ) : (
          <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start lg:gap-5">
            <ClipIndex
              onJump={(id) => {
                hashTarget.current = id;
                setOpenOverride((o) => withOpen(o, id));
              }}
              language={lang}
              entries={items.map((i, n) => ({ id: i.clip.id, n: n + 1, title: i.title, startMs: i.clip.startMs, status: statusOf(i.clip.id), dismissed: i.dismissed }))}
            />
            <ol className="grid gap-4">
              {items.map((item, n) => (
                <Fragment key={item.clip.id}>
                  <ClipCard
                    n={n + 1}
                    item={item}
                    clipState={statusOf(item.clip.id)}
                    inside={insideOf[n] ?? null}
                    open={isOpen(item.clip.id)}
                    onToggle={() => setOpenOverride((o) => ({ ...o, [item.clip.id]: !isOpen(item.clip.id) }))}
                    session={session}
                    defaultCredit={defaultCredit}
                    names={names}
                    creditDiffers={creditDiffers.has(item.clip.id)}
                    formatDiffers={formatDiffers.has(item.clip.id)}
                    timedOut={timedOut && !retrying[item.clip.id]}
                    busy={busy[item.clip.id] ?? false}
                    error={errors[item.clip.id] ?? null}
                    status={statuses[item.clip.id] ?? ""}
                    checklist={checklists.get(item.clip.id)!}
                    onChange={(body, opts) => change(item.clip.id, body, opts)}
                    onUndo={() => (item.undo?.kind === "merge" ? setUndoMergeId(item.clip.id) : void undo(item.clip.id))}
                    onCheckAgain={() => void checkAgain(item.clip.id)}
                    onTrack={(tr) => setTrack(item.clip.id, tr)}
                  />
                  {pairs.has(n) && (() => {
                    const k = pairs.get(n)!;
                    const earlier = items[k]!.clip.id;
                    const later = items[n + 1]!.clip.id;
                    return (
                      <li role="none" className="-my-1 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setMergeIds([earlier, later])}
                          disabled={(busy[earlier] ?? false) || (busy[later] ?? false)}
                          className="inline-flex h-8 items-center rounded-full border border-dashed border-muted-foreground/60 bg-transparent px-3 text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {t("prepare.mergeButton", { a: k + 1, b: n + 2 })}
                        </button>
                      </li>
                    );
                  })()}
                </Fragment>
              ))}
            </ol>
          </div>
        )}

        {mergeIds && mergeA && mergeB && (
          <ConfirmDialog
            open
            onOpenChange={(o) => !o && setMergeIds(null)}
            title={t("prepare.mergeTitle", { a: mergeAt + 1, b: mergeBAt + 1 })}
            description={t("prepare.mergeDescription", {
              a: mergeAt + 1,
              start: formatTimestamp(Math.min(mergeA.clip.startMs, mergeB.clip.startMs)),
              end: formatTimestamp(Math.max(mergeA.clip.endMs, mergeB.clip.endMs)),
            })}
            actionLabel={t("prepare.mergeAction")}
            busyLabel={t("prepare.merging")}
            onConfirm={confirmMerge}
          />
        )}

        {undoMergeId && undoMergeRange && (
          <ConfirmDialog
            open
            onOpenChange={(o) => !o && setUndoMergeId(null)}
            title={t("prepare.undoMergeTitle")}
            description={t("prepare.undoMergeDescription", {
              start: formatTimestamp(undoMergeRange.startMs),
              end: formatTimestamp(undoMergeRange.endMs),
            })}
            actionLabel={t("prepare.undoMerge")}
            busyLabel={t("prepare.undoing")}
            onConfirm={() => runUndo(undoMergeId)}
          />
        )}

        <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <span className="text-sm font-medium text-muted-foreground">{t("prepare.readyCount", { n: readyCount, total: items.length })}</span>
            {readyCount === 0 ? (
              <button
                type="button"
                aria-disabled="true"
                title={t("prepare.exportNone")}
                onClick={(e) => e.preventDefault()}
                className="inline-flex h-9 cursor-not-allowed items-center rounded-lg bg-disabled px-4 text-sm font-semibold text-disabled-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
              >
                {t("prepare.exportReady")}
              </button>
            ) : (
              <Link
                href={`/s/${session.id}/export`}
                className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
              >
                {t("prepare.exportReady")}
              </Link>
            )}
          </div>
        </footer>
      </main>
    </HasVideoProvider>
  );
}

interface ClipCardProps {
  n: number;
  item: Item;
  clipState: ClipStatus;
  /** The number of the clip that contains this one, if any. */
  inside: number | null;
  open: boolean;
  onToggle: () => void;
  session: PrepareListProps["session"];
  defaultCredit: string;
  names: NamesData;
  creditDiffers: boolean;
  formatDiffers: boolean;
  timedOut: boolean;
  busy: boolean;
  error: string | null;
  status: string;
  checklist: ReturnType<typeof exportChecklist>;
  onChange: (body: ClipChange, opts?: { refresh?: boolean; announce?: boolean }) => Promise<boolean>;
  onUndo: () => void;
  onCheckAgain: () => void;
  onTrack: (track: TrackView) => void;
}

function ClipCard({
  n, item, clipState, inside, open, onToggle, session, defaultCredit, names, creditDiffers, formatDiffers, timedOut, busy, error, status, checklist, onChange, onUndo, onCheckAgain, onTrack,
}: ClipCardProps) {
  const { clip, title } = item;
  // R30: once the video is removed the clip is frozen; only the acknowledgements can change.
  const frozen = session.videoRemoved;
  const { checks, originalCut } = checksForClip(clip, item.momentRange ? { ...item.momentRange, checks: item.checks } : null);
  const lang = session.language ?? undefined;
  const [cropDraft, setCropDraft] = useState<number | null>(null);
  const cropOffset = cropDraft ?? clip.cropOffset;
  const headingId = `clip-h-${clip.id}`;
  const bodyId = `clip-body-${clip.id}`;

  const commitBounds = (r: Range, opts: { free: boolean }) =>
    onChange(
      {
        start: formatTimestamp(r.startMs, { tenths: true }),
        end: formatTimestamp(r.endMs, { tenths: true }),
        ...(opts.free ? { free: true as const } : {}),
      },
      { refresh: true, announce: true },
    );

  // The crop slider saves 400 ms after it stops moving (or on release/blur), never the same value twice.
  const [crop] = useState(() =>
    debouncedCommit<number>(() => {}, CROP_COMMIT_MS, clip.cropOffset, (v) => setCropDraft((d) => (d === v ? null : d))),
  );
  useEffect(() => {
    crop.setSend((value: number) =>
      void onChange({ cropOffset: value }).then((ok) => {
        if (!ok) crop.rejected(); // nothing was saved, so the same value may be tried again
        setCropDraft((d) => (d === value ? null : d));
      }),
    );
  });
  useEffect(() => crop.known(clip.cropOffset), [crop, clip.cropOffset]);
  useEffect(() => () => crop.cancel(), [crop]);

  return (
    <li id={`clip-${clip.id}`} className="scroll-mt-20">
      <article aria-labelledby={headingId} className="rounded-xl border border-border bg-white p-3 sm:p-4">
        <header className={cn("flex flex-wrap items-start justify-between gap-2", open && "mb-3")}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? t("prepare.collapseClip", { n }) : t("prepare.expandClip", { n })}
            className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border bg-white outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
          >
            <ChevronRightIcon aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-muted-foreground">
              {t("prepare.clipHeading", { n })} ·{" "}
              {t("prepare.clipLength", { start: formatTimestamp(clip.startMs), length: formatLength(clip.endMs - clip.startMs) })}
            </p>
            <h2
              id={headingId}
              tabIndex={-1}
              lang={lang}
              dir="auto"
              className="rounded-sm text-[15px] font-bold break-words outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {title || t("prepare.clipHeading", { n })}
            </h2>
            {inside !== null && <p className="font-mono text-xs text-muted-foreground">{t("prepare.insideClip", { n: inside })}</p>}
            {open && item.mergedCount > 1 && (
              <p className="font-mono text-xs text-muted-foreground">{t("prepare.mergedFrom", { n: item.mergedCount })}</p>
            )}
            {item.dismissed && (
              <p className="mt-1">
                <ApprovalDismissed id={`${headingId}-dismissed`} />
              </p>
            )}
            {open && item.voices.length > 0 && (
              <p className="mt-0.5 flex flex-wrap items-center text-xs text-muted-foreground">
                <span className="sr-only">{t("briefing.speakers")}: </span>
                {item.voices.map((v, i) => (
                  <Fragment key={`${v.speakerId}:${v.atMs}`}>
                    {i > 0 && <SpeakerSep />}
                    <SpeakerName
                      speakerId={v.speakerId}
                      atMs={v.atMs}
                      names={names}
                      sensitive={PROFILES[session.profile].sensitive}
                      sessionId={session.id}
                      range={{ startMs: clip.startMs, endMs: clip.endMs }}
                      language={lang}
                    />
                  </Fragment>
                ))}
              </p>
            )}
          </div>
          <ClipStatusBadge status={clipState} dismissed={item.dismissed} className="mt-1" />
          {open && item.undo && !frozen && (
            <button
              type="button"
              onClick={onUndo}
              disabled={busy}
              aria-label={t("prepare.undoLabel", { action: undoLabel(item.undo), title: title || t("prepare.clipHeading", { n }) })}
              className="inline-flex h-7 items-center rounded-md border border-border bg-white px-2 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              {undoLabel(item.undo)}
            </button>
          )}
        </header>

        <div id={bodyId} hidden={!open}>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-3">
              <ClipPlayer
                visible={open}
                sessionId={session.id}
                clip={clip}
                title={title}
                format={clip.format}
                cropOffset={cropOffset}
                hasVideo={session.hasVideo}
                videoRemoved={session.videoRemoved}
                thumbUrl={item.thumbUrl}
              />
              <TrimStrip
                clipId={clip.id}
                title={title}
                clip={clip}
                revision={clip.updatedAt}
                durationMs={session.durationMs}
                points={item.points}
                disabled={frozen}
                onCommit={commitBounds}
                onCommitText={(start, end) => onChange({ start, end }, { refresh: true, announce: true })}
              />
              <p role="status" className="flex min-h-4 items-center text-xs text-muted-foreground">
                <Busy busy={busy}>{busy ? t("prepare.saving") : status}</Busy>
              </p>
              {error && (
                <p role="alert" className="-mt-2 text-xs text-red-700">
                  {error}
                </p>
              )}
            </div>

            <div className="grid content-start gap-4">
              <ChecksPanel
                clipId={clip.id}
                title={title}
                language={lang}
                checks={checks}
                originalCut={originalCut}
                timedOut={timedOut}
                warningsAck={clip.warningsAck}
                midSentence={clip.midSentence}
                busy={busy}
                frozen={frozen}
                checkingAgain={busy}
                onAck={(ack) => void onChange({ warningsAck: ack })}
                onExtend={() => void onChange({ extend: "next" }, { refresh: true, announce: true })}
                onCheckAgain={onCheckAgain}
              />
              <FormatPicker
                clipId={clip.id}
                format={clip.format}
                cropOffset={cropOffset}
                hasVideo={session.hasVideo}
                disabled={frozen}
                differs={formatDiffers}
                onFormat={(format: ClipFormat) => void onChange({ format })}
                onCropInput={(v) => {
                  setCropDraft(v);
                  crop.push(v);
                }}
                onCropCommit={crop.flush}
              />
              <CreditField
                key={`${clip.credit ?? ""}|${clip.noCreditNeeded}`}
                clipId={clip.id}
                credit={clip.credit}
                noCreditNeeded={clip.noCreditNeeded}
                defaultCredit={defaultCredit}
                differs={creditDiffers}
                disabled={frozen}
                onCredit={(credit) => void onChange({ credit })}
                onNoCredit={(v) => void onChange({ noCreditNeeded: v })}
              />
              <SubtitlesPanel
                sessionId={session.id}
                clipId={clip.id}
                clip={clip}
                hasVideo={session.hasVideo}
                thumbUrl={item.thumbUrl}
                onLook={(look) => onChange({ subtitleStyle: look.style, subtitlePosition: look.position })}
                originalLanguage={session.language}
                tracks={item.tracks}
                frozen={frozen}
                onTrack={onTrack}
              />
              <Checklist
                clipId={clip.id}
                items={checklist}
                protectedAck={clip.protectedAck}
                busy={busy}
                onProtected={(v) => void onChange({ protectedAck: v })}
              />
            </div>
          </div>
        </div>
      </article>
    </li>
  );
}

/** The clip on the proxy (never the original): `preload="none"` and `#t=start,end`; in 9:16 the frame shows the crop. */
function ClipPlayer({
  visible, sessionId, clip, title, format, cropOffset, hasVideo, videoRemoved, thumbUrl,
}: {
  visible: boolean;
  sessionId: string;
  clip: Range;
  title: string;
  format: ClipFormat;
  cropOffset: number;
  hasVideo: boolean;
  videoRemoved: boolean;
  thumbUrl: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  // A collapsed card stops its player (it unmounts) and starts again from the poster.
  if (!visible && playing) setPlaying(false);
  const src = `/api/files/${sessionId}/proxy.mp4#t=${(clip.startMs / 1000).toFixed(1)},${(clip.endMs / 1000).toFixed(1)}`;
  const label = t("preview.playerLabel", { title });
  const vertical = format === "9:16";
  const fit = vertical ? "h-full w-auto aspect-[9/16] object-cover" : "h-full w-full object-contain";

  const button = (
    <button
      type="button"
      onClick={() => setPlaying((p) => !p)}
      disabled={videoRemoved}
      aria-expanded={playing}
      aria-label={playing ? t("preview.stopLabel", { title }) : t("preview.playLabel", { title })}
      aria-describedby={videoRemoved ? "video-removed" : undefined}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
    >
      {playing ? t("preview.stop") : t("preview.play")}
    </button>
  );

  if (!hasVideo) {
    return (
      <div className="grid gap-2">
        <div>{button}</div>
        {playing && !videoRemoved && <MediaPlayer kind="audio" autoPlay src={src} label={label} className="w-full" />}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-stone-900">
        {videoRemoved ? (
          <p className="px-4 text-center text-xs text-stone-300">{t("preview.videoRemoved")}</p>
        ) : playing ? (
          <MediaPlayer
            key={src}
            kind="video"
            autoPlay
            src={src}
            label={label}
            poster={thumbUrl ?? undefined}
            className={fit}
            style={vertical ? { objectPosition: cropPosition(cropOffset) } : undefined}
          />
        ) : thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a same-origin API file, not a static asset
          <img src={thumbUrl} alt="" loading="lazy" className={cn(fit)} style={vertical ? { objectPosition: cropPosition(cropOffset) } : undefined} />
        ) : (
          <span aria-hidden className={cn(vertical ? "aspect-[9/16] h-full border-x border-dashed border-stone-500" : "")} />
        )}
      </div>
      <div>{button}</div>
    </div>
  );
}

/** The credit line (saved on blur or Enter) or "No credit needed". */
function CreditField({
  clipId, credit, noCreditNeeded, defaultCredit, differs, disabled, onCredit, onNoCredit,
}: {
  clipId: string;
  credit: string | null;
  noCreditNeeded: boolean;
  defaultCredit: string;
  differs: boolean;
  disabled: boolean;
  onCredit: (credit: string | null) => void;
  onNoCredit: (v: boolean) => void;
}) {
  const [value, setValue] = useState(credit ?? "");
  const id = `credit-${clipId}`;
  const save = () => {
    const next = value.trim();
    if (next !== (credit ?? "")) onCredit(next === "" ? null : next);
  };
  const fromMetadata = defaultCredit !== "" && value.trim() === defaultCredit;

  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <label htmlFor={id}>{t("prepare.credit")}</label>
        {differs && <span className="ml-1.5 font-normal tracking-normal normal-case">{t("prepare.differs")}</span>}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          value={value}
          maxLength={200}
          disabled={noCreditNeeded || disabled}
          placeholder={t("prepare.creditPlaceholder")}
          aria-describedby={`${id}-help`}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
        />
        {fromMetadata && !noCreditNeeded && (
          <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-stone-700">{t("context.badgeMetadata")}</span>
        )}
      </div>
      <p id={`${id}-help`} className="mt-1 text-xs text-muted-foreground">
        {t("prepare.creditHelp")}
      </p>
      <label className="mt-1.5 flex items-center gap-2 text-[13px] font-medium">
        <Checkbox checked={noCreditNeeded} disabled={disabled} onCheckedChange={(v) => onNoCredit(v === true)} />
        <span>{t("prepare.noCredit")}</span>
      </label>
    </section>
  );
}
