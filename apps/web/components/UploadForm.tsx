"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadIcon, XIcon } from "lucide-react";
import { estimateCostUsd, parseYouTubeUrl } from "@digestor/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const EXTENSIONS = ["mp4", "mov", "mkv", "webm"];
const UNSUPPORTED = "Unsupported file type. Use MP4, MOV, MKV or WebM.";

type Mode = "file" | "youtube";
type Meta = { durationMs: number; width: number; height: number } | null;
type Upload = { phase: "idle" } | { phase: "uploading"; pct: number } | { phase: "done" };

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin >= 60) return `${Math.floor(totalMin / 60)} h ${totalMin % 60} m`;
  if (totalMin >= 1) return `${totalMin} m`;
  return `${Math.round(ms / 1000)} s`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Rough wall-clock time: processing runs at about 12× real time, never under 2 minutes. */
function estimateMinutes(ms: number): number {
  return Math.max(2, Math.round(ms / 60_000 / 12));
}

function formatCost(usd: number): string {
  return usd < 0.01 ? "< $0.01" : `$${usd.toFixed(2)}`;
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
        reject(new Error(errorFrom(xhr.responseText, "Upload failed. Please try again.")));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
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
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const urlError = youtubeError(url);
  const busy = submitting || upload.phase !== "idle";
  const canSubmit = !busy && (mode === "file" ? file !== null : url.trim() !== "" && urlError === null);

  async function pick(f: File | undefined) {
    if (!f || busy) return;
    setSubmitError(null);
    if (!EXTENSIONS.includes(extOf(f.name))) {
      pickedRef.current = null;
      setFile(null);
      setMeta(null);
      setFileError(UNSUPPORTED);
      return;
    }
    setFileError(null);
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
        sessionId = await putFile(`/api/sessions/upload?${qs}`, file, (pct) => setUpload({ phase: "uploading", pct }));
        setUpload({ phase: "done" });
      } else {
        const res = await fetch("/api/sessions/youtube", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, hint: hint.trim() || undefined }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(errorFrom(text, "Something went wrong. Please try again."));
        sessionId = (JSON.parse(text) as { sessionId: string }).sessionId;
      }
      router.push(`/s/${sessionId}`);
    } catch (err) {
      setUpload({ phase: "idle" });
      setSubmitting(false);
      setSubmitError((err as Error).message);
    }
  }

  const estimate =
    mode === "file" && meta ? (
      <>
        Estimated cost <b className="text-foreground">≈ {formatCost(estimateCostUsd(meta.durationMs))}</b> · time{" "}
        <b className="text-foreground">≈ {estimateMinutes(meta.durationMs)} min</b>
      </>
    ) : mode === "file" && file ? (
      "We'll estimate cost and time once processing starts."
    ) : mode === "youtube" ? (
      "Cost and time depend on the video's length — we'll show them after the download."
    ) : (
      "Pick a video to see the estimated cost and time."
    );

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <Tabs value={mode} onValueChange={(v) => !busy && setMode(v as Mode)} className="md:flex-[1.3]">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="file" disabled={busy && mode !== "file"}>
            Upload a file
          </TabsTrigger>
          <TabsTrigger value="youtube" disabled={busy && mode !== "youtube"}>
            Paste a YouTube link
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
            <span className="font-semibold">Drop a long video here</span>
            <span className="text-sm text-muted-foreground">MP4, MOV, MKV, WebM · up to 4 hours</span>
            <span className="mt-2 text-sm text-muted-foreground underline underline-offset-4">or browse your files</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
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
                    aria-label="Upload progress"
                    className={cn("mt-2", upload.phase === "done" ? "[&_[data-slot=progress-indicator]]:bg-emerald-600" : "[&_[data-slot=progress-indicator]]:bg-brand")}
                  />
                )}
              </div>
              {upload.phase === "done" ? (
                <Badge className="bg-emerald-100 text-emerald-700">Uploaded</Badge>
              ) : upload.phase === "uploading" ? (
                <Badge className="bg-orange-100 text-orange-700 tabular-nums">Uploading {upload.pct}%</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove file"
                  onClick={() => {
                    pickedRef.current = null;
                    setFile(null);
                    setMeta(null);
                  }}
                >
                  <XIcon />
                </Button>
              )}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="youtube" className="flex flex-col gap-2">
          <Card className="gap-2 p-4">
            <label htmlFor="yt-url" className="font-semibold">
              YouTube link
            </label>
            <Input
              id="yt-url"
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=…"
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
              {urlError ?? "A single video (not a playlist). If YouTube blocks the download, upload the file instead."}
            </p>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="h-fit gap-0 p-4 md:mt-10 md:flex-1">
        <label htmlFor="hint" className="font-semibold">
          Anything we should know? <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="hint"
          rows={4}
          className="mt-2"
          value={hint}
          disabled={busy}
          onChange={(e) => setHint(e.target.value)}
          placeholder="e.g. 'Interview with the health minister on the evening news, about hospital waiting lists'"
        />
        <p className="my-3 text-sm text-muted-foreground">{estimate}</p>
        <Button
          size="lg"
          className="h-10 w-full bg-brand text-brand-foreground hover:bg-brand/90"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {upload.phase === "uploading" ? `Uploading… ${upload.pct}%` : submitting ? "Starting…" : "Digest this video →"}
        </Button>
        {submitError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {submitError}
          </p>
        )}
      </Card>
    </div>
  );
}
