"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, Pause, Play, Plus, Trash2 } from "lucide-react";
import { checkTrackLines, formatTimestamp, parseTimestamp, trackLinesVersion, trackToCues } from "@digestor/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { patchTrack } from "@/lib/prepareApi";
import type { ClipView, TrackView } from "@/lib/prepareData";
import { pauseAllMedia } from "@/lib/media";
import { clipPosition, cueAt, reviewColumns, seekFor } from "@/lib/subtitlePreview";
import {
  editLinesFrom, insertLineAfter, insertLineAt, lineProblemText, linesChanged, previewCues, timeField, toLineInputs, type EditLine,
} from "@/lib/trackLines";
import { MediaPlayer } from "@/components/MediaPlayer";
import { cropPosition } from "./FormatPicker";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { Waveform } from "@/components/Waveform";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Busy } from "@/components/ui/spinner";

export interface TrackEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  track: TrackView;
  /** e.g. "German" or "Portuguese (original)". */
  languageLabel: string;
  /** The video's spoken language (the originals are in it). */
  originalLanguage: string | undefined;
  clip: ClipView;
  sessionId: string;
  /** The session has a picture (false: audio only). */
  hasVideo: boolean;
  /** The video was removed (R30): the lines show, without a player, and can't be changed. */
  videoRemoved: boolean;
  /** The clip's poster frame, when there is one. */
  thumbUrl: string | null;
  onSaved: (track: TrackView) => void;
}

/**
 * Review one language's subtitle lines next to the original: edit a line's text or timing, delete or add lines, then
 * approve. Nothing is stored until Save (or Approve), which sends the whole list. Missing lines block approval (the
 * server refuses too). Mount it with `key={track.id}` per opening.
 */
export function TrackEditor({
  open, onOpenChange, track, languageLabel, originalLanguage, clip, sessionId, hasVideo, videoRemoved, thumbUrl, onSaved,
}: TrackEditorProps) {
  const [stored, setStored] = useState(track.cues);
  const [lines, setLines] = useState<EditLine[]>(() => editLinesFrom(track.cues));
  const [timing, setTiming] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** A line to focus after the list changed (its text box), by key. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  /** The player's position inside the clip (ms, like the cue times), and whether it plays. */
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // A state ref: the dialog draws its content after this component mounts.
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const [frameH, setFrameH] = useState(0);
  const columns = reviewColumns(track.language, originalLanguage);
  const vertical = clip.format === "9:16";
  const lengthMs = clip.endMs - clip.startMs;
  const src = `/api/files/${sessionId}/proxy.mp4#t=${(clip.startMs / 1000).toFixed(1)},${(clip.endMs / 1000).toFixed(1)}`;
  const playerLabel = t("prepare.editorPlayerLabel", { language: languageLabel });
  const editable = !videoRemoved;

  // Other players stop while this one is open; closing the dialog unmounts the player, which pauses it.
  useEffect(() => {
    if (open) pauseAllMedia();
  }, [open]);

  // The subtitle drawn over the video scales with the frame.
  useEffect(() => {
    const el = frameEl;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameH(el.clientHeight));
    ro.observe(el);
    setFrameH(el.clientHeight);
    return () => ro.disconnect();
  }, [frameEl]);

  // While playing, follow the video every frame (timeupdate fires only about 4 times a second): the subtitle on the
  // video and the highlighted line change when the made video would change them.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const el = mediaRef.current;
      if (el) onTime(el.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onTime reads only refs and the clip, which don't change while open
  }, [playing]);

  // What the made video shows: the editor's current lines, split and timed as the burn does.
  const previewed = useMemo(() => previewCues(stored, lines), [stored, lines]);
  const shown = useMemo(() => trackToCues(previewed, clip.format, { highlight: clip.subtitleHighlight }), [previewed, clip.format, clip.subtitleHighlight]);
  const onScreen = shown[cueAt(shown, position)];

  // Keep the playing line in view in the scrolling list.
  const activeKey = lines[active]?.key;
  useEffect(() => {
    if (activeKey) document.getElementById(`line-${track.id}-${activeKey}`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey, track.id]);

  // A line just added or deleted: put the cursor in the right text box.
  useEffect(() => {
    if (!focusKey) return;
    const el = document.getElementById(`cue-${track.id}-${focusKey}`);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus();
    setFocusKey(null);
  }, [focusKey, track.id]);

  /** The preview copy counts from the start of the whole video: show and seek in clip time, and stop at the clip's end. */
  function onTime(sec: number) {
    const el = mediaRef.current;
    if (el && !el.paused && sec * 1000 >= clip.endMs) el.pause();
    const pos = clipPosition(sec, clip);
    setPosition(pos);
    setActive(cueAt(linesRef.current, pos));
  }

  function togglePlay() {
    const el = mediaRef.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    // At (or past) the end, play the clip again from its start.
    if (el.currentTime * 1000 >= clip.endMs - 100 || el.currentTime * 1000 < clip.startMs) el.currentTime = clip.startMs / 1000;
    void el.play().catch(() => {});
  }

  function seekClip(ms: number) {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = (clip.startMs + ms) / 1000;
    setPosition(ms);
    setActive(cueAt(linesRef.current, ms));
  }

  function seek(i: number) {
    const el = mediaRef.current;
    const line = lines[i];
    if (!el || !line) return;
    el.currentTime = seekFor(line, clip);
    setActive(i);
    void el.play().catch(() => {});
  }

  function update(i: number, patch: Partial<EditLine>) {
    setNotice(null);
    setLines((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  function add(result: { lines: EditLine[]; index: number } | null) {
    setError(null);
    if (!result) return setNotice(t("prepare.noRoom"));
    setLines(result.lines);
    setFocusKey(result.lines[result.index]!.key);
    setNotice(t("prepare.lineAdded", { n: result.index + 1 }));
  }

  function remove(i: number) {
    const next = lines.filter((_, j) => j !== i);
    setLines(next);
    setFocusKey((next[i] ?? next[i - 1])?.key ?? null);
    setNotice(t("prepare.lineDeleted", { n: i + 1 }));
  }

  function toggleTiming(key: string) {
    setTiming((all) => {
      const next = new Set(all);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const changed = linesChanged(stored, lines);
  const retimed = lines.length !== stored.length || lines.some((l, i) => l.from !== i || l.startMs !== stored[i]?.startMs || l.endMs !== stored[i]?.endMs);
  const problems = checkTrackLines(lines, lengthMs);
  const problemAt = new Map(problems.map((p) => [p.i, lineProblemText(p, lengthMs)]));
  const missing = lines.filter((l) => l.text.trim() === "").length;
  const canSave = editable && changed && problems.length === 0;
  const canApprove = editable && missing === 0 && problems.length === 0 && lines.length > 0 && (!track.approved || changed);

  async function save(): Promise<void> {
    if (!changed) return;
    const updated = await patchTrack(track.id, { lines: toLineInputs(lines), base: trackLinesVersion(stored) });
    onSaved(updated);
    setStored(updated.cues);
    setLines(editLinesFrom(updated.cues));
  }

  async function run(kind: "save" | "approve") {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await save();
      if (kind === "approve") {
        onSaved(await patchTrack(track.id, { approve: true }));
        onOpenChange(false);
      } else {
        setNotice(t("prepare.linesSaved"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-y-auto sm:max-w-3xl sm:overflow-visible">
        <DialogHeader>
          <DialogTitle>{t("prepare.editorTitle", { language: languageLabel })}</DialogTitle>
          <DialogDescription>{t("prepare.editorDescription")}</DialogDescription>
        </DialogHeader>
        {videoRemoved ? (
          <p className="rounded-lg bg-stone-900 px-4 py-6 text-center text-xs text-stone-300">{t("preview.videoRemoved")}</p>
        ) : (
          <div className="grid shrink-0 grid-cols-1 gap-2">
            <div className="flex justify-center">
              {hasVideo ? (
                <div ref={setFrameEl} className={cn("relative overflow-hidden rounded-lg bg-stone-900", vertical ? "aspect-[9/16] h-[min(30vh,16rem)]" : "aspect-video h-[min(30vh,16rem)]")}>
                  <MediaPlayer
                    kind="video"
                    src={src}
                    label={playerLabel}
                    poster={thumbUrl ?? undefined}
                    preload="metadata"
                    mediaRef={mediaRef}
                    controls={false}
                    onTime={onTime}
                    onPlayingChange={setPlaying}
                    className={cn("h-full w-full", vertical ? "object-cover" : "object-contain")}
                    style={vertical ? { objectPosition: cropPosition(clip.cropOffset) } : undefined}
                  />
                  {onScreen && (
                    <SubtitleOverlay
                      cue={onScreen}
                      look={{ style: clip.subtitleStyle, position: clip.subtitlePosition }}
                      format={clip.format}
                      frameHeight={frameH}
                      nowMs={position}
                      lang={track.language}
                    />
                  )}
                </div>
              ) : (
                // Audio only: the made video's waveform, following the sound, with the subtitle over it.
                <div ref={setFrameEl} className={cn("relative overflow-hidden rounded-lg", vertical ? "aspect-[9/16] h-[min(30vh,16rem)]" : "aspect-video h-[min(30vh,16rem)]")}>
                  <MediaPlayer
                    kind="audio"
                    src={src}
                    label={playerLabel}
                    preload="metadata"
                    mediaRef={mediaRef}
                    controls={false}
                    onTime={onTime}
                    onPlayingChange={setPlaying}
                    className="hidden"
                  />
                  <Waveform mediaRef={mediaRef} playing={playing} />
                  {onScreen && (
                    <SubtitleOverlay
                      cue={onScreen}
                      look={{ style: clip.subtitleStyle, position: clip.subtitlePosition }}
                      format={clip.format}
                      frameHeight={frameH}
                      nowMs={position}
                      lang={track.language}
                    />
                  )}
                </div>
              )}
            </div>
            <ClipControls
              position={position}
              length={lengthMs}
              playing={playing}
              label={playerLabel}
              onToggle={togglePlay}
              onSeek={seekClip}
            />
            <div className="flex justify-center">
              <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => add(insertLineAt(lines, position, lengthMs))}>
                <Plus aria-hidden />
                {t("prepare.addLineAt", { time: timeField(position) })}
              </Button>
            </div>
          </div>
        )}
        {videoRemoved && <p className="text-xs text-muted-foreground">{t("prepare.editorReadOnly")}</p>}
        <div className="-mx-4 min-h-64 flex-1 overflow-y-auto border-y border-border px-4 py-2 sm:min-h-0">
          {columns === 2 && (
            <div aria-hidden className="mb-1 hidden grid-cols-2 gap-3 text-xs font-semibold text-muted-foreground sm:grid">
              <span>{t("prepare.colOriginal")}</span>
              <span>{t("prepare.colSubtitle")}</span>
            </div>
          )}
          <ol className="grid gap-2">
            {lines.map((line, i) => {
              const n = i + 1;
              const empty = line.text.trim() === "";
              const id = `cue-${track.id}-${line.key}`;
              const time = formatTimestamp(line.startMs, { tenths: true });
              const times = t("prepare.lineTimes", { start: time, end: timeField(line.endMs) });
              const playingNow = i === active;
              const original = line.from === null ? undefined : stored[line.from];
              const added = !original || original.added;
              const problem = problemAt.get(i);
              const timingId = `timing-${track.id}-${line.key}`;
              const showTiming = timing.has(line.key);
              const describedBy = [empty ? `${id}-missing` : null, problem ? `${id}-problem` : null].filter(Boolean).join(" ") || undefined;
              return (
                <li
                  key={line.key}
                  id={`line-${track.id}-${line.key}`}
                  aria-current={playingNow ? "true" : undefined}
                  className={cn("grid gap-1 rounded-md border-l-4 pl-2", playingNow ? "border-brand bg-muted/60" : "border-transparent")}
                >
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => seek(i)}
                      aria-label={editable ? t("prepare.playFrom", { time }) : undefined}
                      className="rounded-md px-0.5 text-left font-mono text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand enabled:cursor-pointer enabled:hover:bg-hover hover:text-foreground/60 enabled:active:bg-pressed/60"
                    >
                      {times}
                      {playingNow && <span className="sr-only"> {t("prepare.nowPlaying")}</span>}
                    </button>
                    {editable && (
                      <span className="ml-auto flex items-center gap-0.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-expanded={showTiming}
                          aria-controls={showTiming ? timingId : undefined}
                          aria-label={t("prepare.lineTimingLabel", { n })}
                          disabled={busy !== null}
                          onClick={() => toggleTiming(line.key)}
                        >
                          <Clock aria-hidden />
                          {t("prepare.lineTiming")}
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("prepare.addLineAfter", { n })} title={t("prepare.addLineAfter", { n })} disabled={busy !== null} onClick={() => add(insertLineAfter(lines, i, lengthMs))}>
                          <Plus aria-hidden />
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("prepare.deleteLine", { n })} title={t("prepare.deleteLine", { n })} disabled={busy !== null || lines.length === 1} onClick={() => remove(i)}>
                          <Trash2 aria-hidden />
                        </Button>
                      </span>
                    )}
                  </div>
                  {showTiming && editable && (
                    <div id={timingId} role="group" aria-label={t("prepare.lineTimingLabel", { n })} className="grid gap-1 rounded-md bg-muted/50 p-2">
                      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                        <TimeField
                          label={t("prepare.lineStart")}
                          ariaLabel={t("prepare.lineStartLabel", { n })}
                          valueMs={line.startMs}
                          maxMs={lengthMs}
                          disabled={busy !== null}
                          onChange={(ms) => update(i, { startMs: ms })}
                          onUsePlayer={() => update(i, { startMs: Math.round(position) })}
                          usePlayerLabel={t("prepare.startFromPlayer", { n })}
                        />
                        <TimeField
                          label={t("prepare.lineEnd")}
                          ariaLabel={t("prepare.lineEndLabel", { n })}
                          valueMs={line.endMs}
                          maxMs={lengthMs}
                          disabled={busy !== null}
                          onChange={(ms) => update(i, { endMs: ms })}
                          onUsePlayer={() => update(i, { endMs: Math.round(position) })}
                          usePlayerLabel={t("prepare.endFromPlayer", { n })}
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground">{t("prepare.lineTimeHint")}</p>
                    </div>
                  )}
                  <div className={cn("grid gap-1", columns === 2 && "sm:grid-cols-2 sm:gap-3")}>
                    {columns === 2 && (
                      added ? (
                        <p className="text-[13px] italic text-muted-foreground">{t("prepare.addedByYou")}</p>
                      ) : (
                        <p lang={originalLanguage} dir="auto" className="text-[13px] text-foreground/90">
                          <span className="sr-only">{t("prepare.colOriginal")}: </span>
                          {original.original}
                        </p>
                      )
                    )}
                    <div>
                      <label htmlFor={id} className="sr-only">
                        {t("prepare.lineLabel", { n, time })}
                      </label>
                      <textarea
                        id={id}
                        lang={track.language}
                        dir="auto"
                        rows={2}
                        value={line.text}
                        disabled={busy !== null}
                        readOnly={videoRemoved}
                        aria-invalid={empty || problem ? true : undefined}
                        aria-describedby={describedBy}
                        onChange={(e) => update(i, { text: e.target.value })}
                        className={cn(
                          "w-full resize-y rounded-md border bg-white px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand",
                          empty ? "border-red-400 bg-red-50" : "border-border",
                        )}
                      />
                      {empty && (
                        <p id={`${id}-missing`} className="text-xs font-medium text-red-700">
                          {added ? t("prepare.addedEmpty") : t("prepare.missing")}
                        </p>
                      )}
                    </div>
                  </div>
                  {problem && (
                    <p id={`${id}-problem`} className="text-xs font-medium text-red-700">
                      {problem}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="grid gap-1 text-xs">
          {missing > 0 && <p className="text-red-700">{missing === 1 ? t("prepare.missingOne") : t("prepare.missingMany", { n: missing })}</p>}
          {problems.length > 0 && <p className="text-red-700">{lineProblemText(problems[0]!, lengthMs)}</p>}
          {retimed && <p className="text-muted-foreground">{t("prepare.timesNotSaved")}</p>}
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          <p role="status" className="text-muted-foreground">
            {notice}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("prepare.close")}
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || !canSave} onClick={() => void run("save")}>
            <Busy busy={busy === "save"}>{busy === "save" ? t("prepare.saving") : t("prepare.saveLines")}</Busy>
          </Button>
          <Button type="button" disabled={busy !== null || !canApprove} onClick={() => void run("approve")}>
            <Busy busy={busy === "approve"}>{busy === "approve" ? t("prepare.approving") : t("prepare.approve")}</Busy>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One time of a line (clip time, typed like 0:25.6): applied when it parses, on blur or Enter; the up and down arrows
 * move it by 0.1 s (Shift: 1 s), within the clip. "Use player time" takes the player's position.
 */
function TimeField({
  label, ariaLabel, valueMs, maxMs, disabled, onChange, onUsePlayer, usePlayerLabel,
}: {
  label: string;
  ariaLabel: string;
  valueMs: number;
  maxMs: number;
  disabled: boolean;
  onChange: (ms: number) => void;
  onUsePlayer: () => void;
  usePlayerLabel: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const errorId = `${ariaLabel.replace(/\W+/g, "-")}-bad`;

  function commit() {
    if (draft === null) return;
    try {
      onChange(Math.min(parseTimestamp(draft), maxMs));
      setDraft(null);
      setBad(false);
    } catch {
      setBad(true);
    }
  }

  return (
    <div className="grid gap-0.5">
      <span aria-hidden className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={ariaLabel}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? errorId : undefined}
          disabled={disabled}
          value={draft ?? timeField(valueMs)}
          onChange={(e) => {
            setDraft(e.target.value);
            setBad(false);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const step = (e.shiftKey ? 1000 : 100) * (e.key === "ArrowUp" ? 1 : -1);
              setDraft(null);
              setBad(false);
              onChange(Math.max(0, Math.min(maxMs, valueMs + step)));
            }
          }}
          className={cn(
            "h-7 w-28 rounded-md border bg-white px-2 font-mono text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-brand",
            bad ? "border-red-400 bg-red-50" : "border-border",
          )}
        />
        <Button type="button" size="xs" variant="outline" aria-label={usePlayerLabel} disabled={disabled} onClick={() => {
          setDraft(null);
          setBad(false);
          onUsePlayer();
        }}>
          {t("prepare.usePlayerTime")}
        </Button>
      </div>
      {bad && (
        <p id={errorId} className="text-[11px] font-medium text-red-700">
          {t("prepare.badTime")}
        </p>
      )}
    </div>
  );
}

/**
 * Play/pause, a position slider and the time, all inside the clip: 0:00 is the clip's start, as in the cue times (the
 * browser's own controls would count from the start of the whole video).
 */
function ClipControls({
  position, length, playing, label, onToggle, onSeek,
}: {
  position: number;
  length: number;
  playing: boolean;
  label: string;
  onToggle: () => void;
  onSeek: (ms: number) => void;
}) {
  const now = formatTimestamp(position, { tenths: true });
  const total = formatTimestamp(length, { tenths: true });
  return (
    <div role="group" aria-label={label} className="mx-auto flex w-full max-w-xl items-center gap-2">
      <Button type="button" size="icon-sm" variant="outline" aria-label={playing ? t("prepare.editorPause") : t("prepare.editorPlay")} onClick={onToggle}>
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </Button>
      <input
        type="range"
        min={0}
        max={length}
        step={100}
        value={Math.min(position, length)}
        aria-label={t("prepare.editorPosition")}
        aria-valuetext={t("prepare.editorTime", { now, total })}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-brand"
      />
      <span aria-hidden className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
        {now} / {total}
      </span>
    </div>
  );
}
