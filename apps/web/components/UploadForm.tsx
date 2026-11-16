"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, UploadIcon, XIcon } from "lucide-react";
import { WARNING_BOX, WarningIcon } from "@/components/WarningNote";
import { PROCESSING_USD_PER_HOUR, SPOKEN_LANGUAGE_CODES, estimateCostUsd, isAudioExtension, isUploadExtension, parseYouTubeUrl } from "@digestor/core";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { aboutUsd } from "@/lib/cost";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { recordFieldError } from "@/components/Names/RecordLink";
import { holdsLink, RecordHouseSelect, recordHelpText, useRecordHouse } from "@/components/Names/RecordHouseSelect";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Dropdown } from "@/components/Dropdown";
import { Busy } from "@/components/ui/spinner";

type Mode = "file" | "youtube";
type Meta = { durationMs: number; width: number; height: number } | null;
type Upload = { phase: "idle" } | { phase: "uploading"; pct: number } | { phase: "done" };

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin >= 60) return t("upload.durationHm", { h: Math.floor(totalMin / 60), m: totalMin % 60 });
  if (totalMin >= 1) return t("upload.durationM", { m: totalMin });
  return t("upload.durationS", { s: Math.round(ms / 1000) });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return t("upload.sizeGb", { n: (bytes / 1024 ** 3).toFixed(1) });
  return t("upload.sizeMb", { n: Math.max(0.1, bytes / 1024 ** 2).toFixed(1) });
}

/** Rough wall-clock time: processing runs at about 12× real time, never under 2 minutes. */
function estimateMinutes(ms: number): number {
  return Math.max(2, Math.round(ms / 60_000 / 12));
}

/** "≈ $0.42", or "under $0.01" for a short file (never "≈ < $0.01"). */
function formatCost(usd: number): string {
  return usd < 0.01 ? t("upload.costUnder") : `≈ $${usd.toFixed(2)}`;
}

/** Reads duration and resolution in the browser; null when the browser can't decode the container (e.g. some MKVs). */
function readMetadata(file: File): Promise<Meta> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (meta: Meta) => {
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      done(
        Number.isFinite(video.duration)
          ? { durationMs: video.duration * 1000, width: video.videoWidth, height: video.videoHeight }
          : null,
      );
    video.onerror = () => done(null);
    video.src = url;
  });
}

function errorFrom(text: string, fallback: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/** Streams the file as the raw request body so the server never buffers it; reports upload progress. */
function putFile(url: string, file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const { sessionId } = JSON.parse(xhr.responseText) as { sessionId: string };
        resolve(sessionId);
      } else {
        reject(new Error(errorFrom(xhr.responseText, t("upload.errorUploadFailed"))));
      }
    };
    xhr.onerror = () => reject(new Error(t("upload.errorUploadConnection")));
    xhr.send(file);
  });
}

function youtubeError(url: string): string | null {
  if (!url.trim()) return null;
  try {
    parseYouTubeUrl(url);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<File | null>(null);
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<Meta>(null);
  const [audioAck, setAudioAck] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState("");
  const [record, setRecord] = useState("");
  const [house, pickHouse, showHouse] = useRecordHouse();
  // Closed until asked for; a typed link or a picked house keeps it open.
  const [recordOpenAsked, setRecordOpen] = useState(false);
  const recordOpen = recordOpenAsked || record.trim() !== "" || house !== "";
  const [language, setLanguage] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The pay check: "Digest this video" first says what will be paid, then Continue starts it. */
  const [confirmOpen, setConfirmOpen] = useState(false);

  const urlError = youtubeError(url);
  const recordError = record.trim() ? recordFieldError(record, house || undefined) : null;
  const busy = submitting || upload.phase !== "idle";
  const audioOnly = file !== null && isAudioExtension(extOf(file.name));
  // An audio file waits for the "no video picture" tick: the button says why it can't go on yet.
  const audioWaiting = mode === "file" && audioOnly && !audioAck && !busy;
  const canSubmit = !busy && recordError === null && (mode === "file" ? file !== null && (!audioOnly || audioAck) : url.trim() !== "" && urlError === null);

  async function pick(f: File | undefined) {
    if (!f || busy) return;
    setSubmitError(null);
    if (!isUploadExtension(extOf(f.name))) {
      pickedRef.current = null;
      setFile(null);
      setMeta(null);
      setFileError(t("upload.unsupported"));
      return;
    }
    setFileError(null);
    setAudioAck(false);
    setFile(f);
    setMeta(null);
    pickedRef.current = f;
    const m = await readMetadata(f);
    if (pickedRef.current === f) setMeta(m); // ignore a stale read if another file was picked meanwhile
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      let sessionId: string;
      if (mode === "file" && file) {
        setUpload({ phase: "uploading", pct: 0 });
        const qs = new URLSearchParams({ filename: file.name });
        if (hint.trim()) qs.set("hint", hint.trim());
        if (record.trim()) qs.set("record", record.trim());
        if (record.trim() && house) qs.set("chamber", house);
        if (language) qs.set("language", language);
        if (audioOnly) qs.set("audioOnlyAck", "1");
        sessionId = await putFile(`/api/sessions/upload?${qs}`, file, (pct) => setUpload({ phase: "uploading", pct }));
        setUpload({ phase: "done" });
      } else {
        const res = await fetch("/api/sessions/youtube", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, hint: hint.trim() || undefined, record: record.trim() || undefined, chamber: record.trim() && house ? house : undefined, language: language || undefined }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(errorFrom(text, t("upload.errorGeneric")));
        sessionId = (JSON.parse(text) as { sessionId: string }).sessionId;
      }
      router.push(`/s/${sessionId}`);
    } catch (err) {
      setUpload({ phase: "idle" });
      setSubmitting(false);
      setSubmitError((err as Error).message);
    }
  }

  // What the pay check says: the estimate when the length is known, else the hourly rate.
  const confirmText =
    mode === "file" && meta
      ? {
          description: t("cost.uploadFile", { length: formatDuration(meta.durationMs) }),
          estimate: t("cost.uploadFileCost", { cost: aboutUsd(estimateCostUsd(meta.durationMs, { captions: !audioOnly })) }),
        }
      : {
          description: mode === "file" ? t("cost.uploadUnknown") : t("cost.uploadYoutube"),
          estimate: t("cost.uploadRate", { rate: aboutUsd(PROCESSING_USD_PER_HOUR) }),
        };

  const estimate =
    mode === "file" && meta ? (
      <>
        {t("upload.estimateCost")} <b className="text-foreground">{formatCost(estimateCostUsd(meta.durationMs, { captions: !audioOnly }))}</b> · {t("upload.estimateTime")}{" "}
        <b className="text-foreground">≈ {t("upload.minutes", { n: estimateMinutes(meta.durationMs) })}</b>
      </>
    ) : mode === "file" && file ? (
      t("upload.estimateAfterStart")
    ) : mode === "youtube" ? (
      t("upload.estimateYoutube")
    ) : (
      t("upload.estimatePick")
    );

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <Tabs value={mode} onValueChange={(v) => !busy && setMode(v as Mode)} className="md:flex-[1.3]">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="file" disabled={busy && mode !== "file"}>
            {t("upload.tabFile")}
          </TabsTrigger>
          <TabsTrigger value="youtube" disabled={busy && mode !== "youtube"}>
            {t("upload.tabYoutube")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="flex flex-col gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void pick(e.dataTransfer.files[0]);
            }}
            className={cn(
              "flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed border-[#d8d4ca] bg-[#fbfaf7] px-6 py-8 text-center transition-colors",
              "hover:border-brand/60 focus-visible:border-brand focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
              dragging && "border-brand bg-brand/5",
            )}
          >
            <UploadIcon className="mb-1 size-7 text-muted-foreground" aria-hidden />
            <span className="font-semibold">{t("upload.dropTitle")}</span>
            <span className="text-sm text-muted-foreground">{t("upload.dropFormats")}</span>
            <span className="mt-2 text-sm text-muted-foreground underline underline-offset-4">{t("upload.browse")}</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".mp4,.mov,.mkv,.webm,.mp3,.m4a,.wav,video/mp4,video/quicktime,video/x-matroska,video/webm,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav"
            className="hidden"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {fileError && (
            <p role="alert" className="text-sm text-destructive">
              {fileError}
            </p>
          )}

          {file && (
            <Card className="flex-row items-center gap-3 p-3">
              <div
                aria-hidden
                className="aspect-video w-[74px] shrink-0 rounded-md bg-gradient-to-br from-[#4a5a80] to-[#1d2438]"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{file.name}</div>
                <div className="text-sm text-muted-foreground">
                  {[meta && formatDuration(meta.durationMs), formatSize(file.size), meta?.width ? `${meta.width}×${meta.height}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {upload.phase !== "idle" && (
                  <Progress
                    value={upload.phase === "done" ? 100 : upload.pct}
                    aria-label={t("upload.uploadProgress")}
                    className={cn("mt-2", upload.phase === "done" ? "[&_[data-slot=progress-indicator]]:bg-emerald-600" : "[&_[data-slot=progress-indicator]]:bg-brand")}
                  />
                )}
              </div>
              {upload.phase === "done" ? (
                <Badge className="bg-emerald-100 text-emerald-700">{t("upload.uploaded")}</Badge>
              ) : upload.phase === "uploading" ? (
                <Badge className="bg-orange-100 text-orange-700 tabular-nums">{t("upload.uploadingBadge", { pct: upload.pct })}</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("upload.removeFile")}
                  onClick={() => {
                    pickedRef.current = null;
                    setAudioAck(false);
                    setFile(null);
                    setMeta(null);
                  }}
                >
                  <XIcon />
                </Button>
              )}
            </Card>
          )}
          {audioOnly && (
            <div className={`flex flex-col gap-2 rounded-xl border p-3 text-sm ${WARNING_BOX}`}>
              <p role="status" className="flex items-start gap-2">
                <WarningIcon className="mt-0.5" />
                <span>{t("upload.audioOnlyWarning")}</span>
              </p>
              <label className="flex items-start gap-2 font-medium">
                <Checkbox
                  checked={audioAck}
                  disabled={busy}
                  onCheckedChange={(v) => setAudioAck(v === true)}
                  className="mt-0.5"
                />
                <span>{t("upload.audioOnlyCheckbox")}</span>
              </label>
            </div>
          )}
        </TabsContent>

        <TabsContent value="youtube" className="flex flex-col gap-2">
          <Card className="gap-2 p-4">
            <label htmlFor="yt-url" className="font-semibold">
              {t("upload.youtubeLabel")}
            </label>
            <Input
              id="yt-url"
              type="url"
              inputMode="url"
              placeholder={t("upload.youtubePlaceholder")}
              value={url}
              disabled={busy}
              aria-invalid={urlError !== null}
              aria-describedby="yt-help"
              onChange={(e) => {
                setUrl(e.target.value);
                setSubmitError(null);
              }}
            />
            <p id="yt-help" className={cn("text-sm", urlError ? "text-destructive" : "text-muted-foreground")}>
              {urlError ?? t("upload.youtubeHelp")}
            </p>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="h-fit gap-0 p-4 md:mt-10 md:flex-1">
        <label htmlFor="hint" className="font-semibold">
          {t("upload.hintLabel")} <span className="font-normal text-muted-foreground">{t("upload.hintOptional")}</span>
        </label>
        <Textarea
          id="hint"
          rows={4}
          className="mt-2"
          value={hint}
          disabled={busy}
          onChange={(e) => setHint(e.target.value)}
          placeholder={t("upload.hintPlaceholder")}
        />
        <button
          type="button"
          aria-expanded={recordOpen}
          aria-controls="record-section"
          onClick={() => setRecordOpen((o) => !o)}
          className="mt-4 inline-flex items-center gap-1 self-start rounded-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", recordOpen && "rotate-90")} />
          {t("upload.recordLabel")} <span className="font-normal text-muted-foreground">{t("upload.recordOptional")}</span>
        </button>
        <div id="record-section" hidden={!recordOpen} className="flex flex-col">
          <div className="mt-2">
            <RecordHouseSelect
              id="record-house"
              value={house}
              disabled={busy}
              describedBy="record-help"
              onChange={(next) => {
                pickHouse(next);
                setSubmitError(null);
              }}
            />
          </div>
          <Input
            id="record"
            className="mt-2"
            value={record}
            disabled={busy}
            dir="auto"
            aria-invalid={recordError !== null}
            aria-describedby="record-help"
            onChange={(e) => {
              setRecord(e.target.value);
              if (holdsLink(e.target.value)) showHouse("");
              setSubmitError(null);
            }}
            placeholder={t("upload.recordPlaceholder")}
          />
          <p id="record-help" className={cn("mt-1 text-xs break-words", recordError ? "text-destructive" : "text-muted-foreground")} role={recordError ? "alert" : undefined}>
            {recordError ?? recordHelpText(house)}
          </p>
        </div>
        <label htmlFor="language" className="mt-4 font-semibold">
          {t("upload.languageLabel")} <span className="font-normal text-muted-foreground">{t("upload.languageOptional")}</span>
        </label>
        <Dropdown
          id="language"
          className="mt-2"
          value={language}
          disabled={busy}
          aria-describedby="language-help"
          onValueChange={setLanguage}
          options={[
            { value: "", label: t("upload.languageAuto") },
            ...SPOKEN_LANGUAGE_CODES.map((code) => ({ value: code as string, label: t(`upload.language_${code}`) })),
          ]}
        />
        <p id="language-help" className="mt-1 text-xs text-muted-foreground">
          {t("upload.languageHelp")}
        </p>
        <p className="my-3 text-sm text-muted-foreground">{estimate}</p>
        <Button
          size="lg"
          className="h-10 w-full bg-brand text-brand-foreground hover:brightness-90"
          disabled={!canSubmit}
          aria-describedby={audioWaiting ? "audio-ack-hint" : undefined}
          onClick={() => canSubmit && setConfirmOpen(true)}
        >
          <Busy busy={upload.phase === "uploading" || submitting}>
            {upload.phase === "uploading" ? t("upload.submitUploading", { pct: upload.pct }) : submitting ? t("upload.submitStarting") : t("upload.submit")}
          </Busy>
        </Button>
        {audioWaiting && (
          <p id="audio-ack-hint" className="mt-2 text-xs text-muted-foreground">
            {t("upload.audioAckHint", { label: t("upload.audioOnlyCheckbox") })}
          </p>
        )}
        {submitError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {submitError}
          </p>
        )}
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={t("cost.uploadTitle")}
          description={confirmText.description}
          estimate={confirmText.estimate}
          actionLabel={t("cost.uploadAction")}
          // Closes at once: the upload's progress shows on the form, and its errors there too.
          onConfirm={async () => void submit()}
        />
      </Card>
    </div>
  );
}
