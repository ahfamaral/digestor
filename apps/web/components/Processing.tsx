"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PROFILES, type ProfileId } from "@digestor/core";
import { buildSteps, type StageName } from "@/lib/processingSteps";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";

export interface ProgressState {
  stage: StageName;
  progress: number;
  language: string | null;
  profile: string | null;
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

/** Processing screen: live stepper fed by SSE; refreshes the server page when the pipeline pauses or ends. */
export function Processing({ sessionId, source, initial }: { sessionId: string; source: "upload" | "youtube"; initial: ProgressState }) {
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

  const steps = buildSteps(state.stage, source);
  const language = state.language;
  const type = eventLabel(state.profile);

  return (
    <div className="mx-auto max-w-xl rounded-xl border border-border bg-white px-4 py-1.5">
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
            <div className={cn("text-sm", s.state === "waiting" ? "text-muted-foreground" : "font-semibold")}>
              {s.label}
              <span className="sr-only"> ({t(STATE_KEY[s.state])})</span>
            </div>
            {s.key === "transcribing" && s.state === "done" && language && (
              <div className="text-xs text-muted-foreground">
                {t("processing.language")} <b className="text-foreground">{language}</b>
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
  );
}
