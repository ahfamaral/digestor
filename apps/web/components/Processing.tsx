"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PROFILES, type ProfileId } from "@digestor/core";
import { buildSteps, type StageName } from "@/lib/processingSteps";
import { foundNoVideo } from "@/lib/media";
import { WarningNote } from "@/components/WarningNote";
import { cn } from "@/lib/utils";
import { languageName, t, type MessageKey } from "@/lib/i18n";
import { Busy } from "@/components/ui/spinner";
import { estimateCostUsd, formatLength } from "@digestor/core";
import { aboutUsd } from "@/lib/cost";

export interface ProgressState {
  stage: StageName;
  progress: number;
  language: string | null;
  profile: string | null;
  /** From the live events: false once the worker found no picture. */
  hasVideo?: boolean;
  /** The video's length once known (from the live events): the cost estimate shows then. */
  durationMs?: number | null;
}

const CLOSING: StageName[] = ["awaiting_context", "ready", "failed"];

const STATE_KEY = {
  done: "processing.stateDone",
  running: "processing.stateRunning",
  waiting: "processing.stateWaiting",
} as const satisfies Record<string, MessageKey>;

function eventLabel(id: string | null): string | null {
  return id && id in PROFILES ? t(`profile.${id as ProfileId}`) : null;
}

/**
 * Processing screen: live stepper fed by SSE; refreshes the server page when the pipeline pauses or ends.
 * `hasVideo` / `audioOnlyAck` are the session's at render time; the events update `hasVideo` once the file is probed.
 */
export function Processing({
  sessionId, source, hasVideo = true, audioOnlyAck = false, initial,
}: { sessionId: string; source: "upload" | "youtube"; hasVideo?: boolean; audioOnlyAck?: boolean; initial: ProgressState }) {
  const router = useRouter();
  const [state, setState] = useState(initial);

  useEffect(() => {
    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    es.onmessage = (e) => {
      const next = JSON.parse(e.data) as ProgressState;
      setState(next);
      if (CLOSING.includes(next.stage)) {
        es.close(); // no reconnect loop after the server ends the stream
        router.refresh();
      }
    };
    // EventSource reconnects on its own after transient errors; if the server closed it for good, stop.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) router.refresh();
    };
    return () => es.close();
  }, [sessionId, router]);

  const liveHasVideo = state.hasVideo ?? hasVideo;
  const steps = buildSteps(state.stage, source, liveHasVideo && !audioOnlyAck);
  const noVideo = foundNoVideo({ hasVideo: liveHasVideo, audioOnlyAck });
  const language = state.language;
  const type = eventLabel(state.profile);
  const durationMs = state.durationMs ?? null;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3">
    {noVideo && <WarningNote role="status">{t("upload.audioOnlyWarning")}</WarningNote>}
    <div className="rounded-xl border border-border bg-white px-4 py-1.5">
      {steps.map((s, i) => (
        <div key={s.key} className={cn("flex items-start gap-3 py-3", i < steps.length - 1 && "border-b border-border")} data-state={s.state}>
          <span
            aria-hidden
            className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold",
              s.state === "done" && "bg-emerald-100 text-emerald-700",
              s.state === "running" && "bg-brand text-white",
              s.state === "waiting" && "bg-muted text-muted-foreground",
            )}
          >
            {s.state === "done" ? "✓" : s.state === "running" ? "●" : i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className={cn("flex items-center text-sm", s.state === "waiting" ? "text-muted-foreground" : "font-semibold")}>
              <Busy busy={s.state === "running"}>{s.label}</Busy>
              <span className="sr-only"> ({t(STATE_KEY[s.state])})</span>
            </div>
            {s.key === "transcribing" && s.state === "done" && language && (
              <div className="text-xs text-muted-foreground">
                {t("processing.language")} <b className="text-foreground">{languageName(language)}</b>
              </div>
            )}
            {s.key === "understanding" && s.state !== "waiting" && type && (
              <div className="text-xs text-muted-foreground">
                {t("processing.profile")} <b className="text-foreground">{type}</b>
              </div>
            )}
            {s.state === "running" && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={state.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-brand transition-all" style={{ width: `${Math.max(3, state.progress)}%` }} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
    {durationMs !== null && durationMs > 0 && (
      <p className="text-xs text-muted-foreground">
        {t("cost.processing", { cost: aboutUsd(estimateCostUsd(durationMs, { captions: liveHasVideo && !audioOnlyAck })), length: formatLength(durationMs) })}
      </p>
    )}
    </div>
  );
}
