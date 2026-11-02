"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  PROFILES, checksForClip, exportChecklist, formatLength, formatTimestamp, type ClipFormat, type MomentChecks, type ProfileId, type Range,
} from "@digestor/core";
import { SpeakerName } from "@/components/Names/SpeakerName";
import type { NamesData, Voice } from "@/lib/names";
import { AppBar } from "@/components/AppBar";
import { debouncedCommit } from "@/lib/debouncedCommit";
import { fetchChecks, fetchTracks, patchClip, requestChecks, undoClip, type ClipChange } from "@/lib/prepareApi";
import { checksToPoll, type ClipView, type TrackView } from "@/lib/prepareData";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { ChecksPanel } from "./ChecksPanel";
import { Checklist } from "./Checklist";
import { FormatPicker, cropPosition } from "./FormatPicker";
import { SubtitlesPanel } from "./SubtitlesPanel";
import { TrimStrip } from "./TrimStrip";

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
  canUndo: boolean;
  /** Who speaks in the clip's current range (longest first). */
  voices: Voice[];
  thumbUrl: string | null;
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

/**
 * Prepare clips: one card per confirmed clip with the trim strip, checks, format, credit, subtitles and the
 * pre-export checklist, and "Export ready clips →".
 */
export function PrepareList({ session, defaultCredit, names, clips }: PrepareListProps) {
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
      update(id, (i) => ({ ...i, clip, canUndo: i.canUndo || "start" in body || "extend" in body || "format" in body || "cropOffset" in body }));
      if (opts.announce) {
        setFor(setStatuses, id, t("prepare.savedRange", { start: formatTimestamp(clip.startMs, { tenths: true }), end: formatTimestamp(clip.endMs, { tenths: true }) }));
      }
      // New bounds need the cut positions of the new window (and a fresh undo state) from the server.
      if (opts.refresh) router.refresh();
      setBusy((b) => ({ ...b, [id]: false }));
      return true;
    } catch (err) {
      setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy((b) => ({ ...b, [id]: false }));
    return false;
  }

  async function undo(id: string) {
    setFor(setErrors, id, null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const clip = await undoClip(id);
      update(id, (i) => ({ ...i, clip }));
      setFor(setStatuses, id, t("prepare.savedRange", { start: formatTimestamp(clip.startMs, { tenths: true }), end: formatTimestamp(clip.endMs, { tenths: true }) }));
      router.refresh();
    } catch (err) {
      setFor(setErrors, id, err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy((b) => ({ ...b, [id]: false }));
  }

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
      }),
    ]),
  );
  const readyCount = items.filter((i) => checklists.get(i.clip.id)!.every((x) => x.ok)).length;

  return (
    <>
      <AppBar current="Prepare" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6">
        <header className="mb-3">
          <Link
            href={`/s/${session.id}/briefing`}
            className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand"
          >
            {t("prepare.backToBriefing")}
          </Link>
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

        {items.length === 0 ? (
          <div className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
            <p>{t("prepare.noClips")}</p>
            <Link href={`/s/${session.id}/briefing`} className="mt-2 inline-block text-foreground underline underline-offset-2">
              {t("prepare.openBriefing")}
            </Link>
          </div>
        ) : (
          <ol className="grid gap-4">
            {items.map((item, n) => (
              <ClipCard
                key={item.clip.id}
                n={n + 1}
                item={item}
                session={session}
                defaultCredit={defaultCredit}
                names={names}
                timedOut={timedOut && !retrying[item.clip.id]}
                busy={busy[item.clip.id] ?? false}
                error={errors[item.clip.id] ?? null}
                status={statuses[item.clip.id] ?? ""}
                checklist={checklists.get(item.clip.id)!}
                onChange={(body, opts) => change(item.clip.id, body, opts)}
                onUndo={() => void undo(item.clip.id)}
                onCheckAgain={() => void checkAgain(item.clip.id)}
                onTrack={(tr) => setTrack(item.clip.id, tr)}
              />
            ))}
          </ol>
        )}

        <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <span className="text-sm font-medium text-muted-foreground">{t("prepare.readyCount", { n: readyCount, total: items.length })}</span>
            <Link
              href={`/s/${session.id}/export`}
              className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            >
              {t("prepare.exportReady")}
            </Link>
          </div>
        </footer>
      </main>
    </>
  );
}

interface ClipCardProps {
  n: number;
  item: Item;
  session: PrepareListProps["session"];
  defaultCredit: string;
  names: NamesData;
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
  n, item, session, defaultCredit, names, timedOut, busy, error, status, checklist, onChange, onUndo, onCheckAgain, onTrack,
}: ClipCardProps) {
  const { clip, title } = item;
  // R30: once the video is removed the clip is frozen; only the acknowledgements can change.
  const frozen = session.videoRemoved;
  const { checks, originalCut } = checksForClip(clip, item.momentRange ? { ...item.momentRange, checks: item.checks } : null);
  const lang = session.language ?? undefined;
  const [cropDraft, setCropDraft] = useState<number | null>(null);
  const cropOffset = cropDraft ?? clip.cropOffset;
  const headingId = `clip-h-${clip.id}`;

  const commitBounds = (r: Range) =>
    onChange(
      { start: formatTimestamp(r.startMs, { tenths: true }), end: formatTimestamp(r.endMs, { tenths: true }) },
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
    <li>
      <article aria-labelledby={headingId} className="rounded-xl border border-border bg-white p-3 sm:p-4">
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">
              {t("prepare.clipHeading", { n })} ·{" "}
              {t("prepare.clipLength", { start: formatTimestamp(clip.startMs), length: formatLength(clip.endMs - clip.startMs) })}
            </p>
            <h2 id={headingId} lang={lang} dir="auto" className="text-[15px] font-bold break-words">
              {title || t("prepare.clipHeading", { n })}
            </h2>
            {item.voices.length > 0 && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="sr-only">{t("briefing.speakers")}: </span>
                {item.voices.map((v) => (
                  <SpeakerName
                    key={v.speakerId}
                    speakerId={v.speakerId}
                    atMs={v.atMs}
                    names={names}
                    sensitive={PROFILES[session.profile].sensitive}
                    sessionId={session.id}
                    range={{ startMs: clip.startMs, endMs: clip.endMs }}
                    language={lang}
                  />
                ))}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onUndo}
            disabled={!item.canUndo || busy || frozen}
            aria-label={t("prepare.undoLabel", { title: title || t("prepare.clipHeading", { n }) })}
            title={item.canUndo ? undefined : t("prepare.undoNothing")}
            className="inline-flex h-7 items-center rounded-md border border-border bg-white px-2 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("prepare.undo")}
          </button>
        </header>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-3">
            <ClipPlayer
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
            <p role="status" className="min-h-4 text-xs text-muted-foreground">
              {busy ? t("prepare.saving") : status}
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
              disabled={frozen}
              onCredit={(credit) => void onChange({ credit })}
              onNoCredit={(v) => void onChange({ noCreditNeeded: v })}
            />
            <SubtitlesPanel
              sessionId={session.id}
              clipId={clip.id}
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
      </article>
    </li>
  );
}

/** The clip on the proxy (never the original): `preload="none"` and `#t=start,end`; in 9:16 the frame shows the crop. */
function ClipPlayer({
  sessionId, clip, title, format, cropOffset, hasVideo, videoRemoved, thumbUrl,
}: {
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
        {playing && !videoRemoved && <audio controls autoPlay preload="none" src={src} aria-label={label} className="w-full" />}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-stone-900">
        {videoRemoved ? (
          <p className="px-4 text-center text-xs text-stone-300">{t("preview.videoRemoved")}</p>
        ) : playing ? (
          <video
            key={src}
            controls
            autoPlay
            preload="none"
            src={src}
            aria-label={label}
            className={fit}
            style={vertical ? { objectPosition: cropPosition(cropOffset) } : undefined}
          />
        ) : thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a same-origin API file, not a static asset
          <img src={thumbUrl} alt="" className={cn(fit)} style={vertical ? { objectPosition: cropPosition(cropOffset) } : undefined} />
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
  clipId, credit, noCreditNeeded, defaultCredit, disabled, onCredit, onNoCredit,
}: {
  clipId: string;
  credit: string | null;
  noCreditNeeded: boolean;
  defaultCredit: string;
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
