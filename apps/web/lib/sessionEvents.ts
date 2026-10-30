import { getSession, type Db, type Stage } from "@digestor/core/server";

/** What the Processing screen needs; sent as one SSE `data:` line whenever it changes. */
export interface ProgressEvent {
  stage: Stage;
  progress: number;
  error: string | null;
  language: string | null;
  profile: string | null;
}

/** After these the pipeline is paused for a human or finished, so the stream ends. */
export const CLOSING_STAGES: readonly Stage[] = ["awaiting_context", "ready", "failed"];

const DEFAULT_TIMING = { pollMs: 1000, heartbeatMs: 15000 };
let timing = DEFAULT_TIMING;

/** Test seam: shorten the poll and heartbeat intervals; `null` restores the defaults. */
export function setEventTimingForTests(t: { pollMs: number; heartbeatMs: number } | null): void {
  timing = t ?? DEFAULT_TIMING;
}

/** SSE body that polls the session row and pushes changes; stops on a closing stage or client abort. */
export function sessionEventStream(db: Db, id: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const { pollMs, heartbeatMs } = timing;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let stop: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let last = "";
      stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(poll);
        clearInterval(beat);
        signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // already closed or cancelled
        }
      };
      signal.addEventListener("abort", stop);
      if (signal.aborted) return stop();
      beat = setInterval(() => {
        if (!stopped) controller.enqueue(enc.encode(": ping\n\n"));
      }, heartbeatMs);

      const tick = async () => {
        try {
          const s = await getSession(db, id);
          if (stopped) return;
          if (!s) return stop(); // deleted by the retention job
          const event: ProgressEvent = {
            stage: s.stage,
            progress: s.progress,
            error: s.error,
            language: s.language,
            profile: s.profile,
          };
          const payload = JSON.stringify(event);
          if (payload !== last) {
            last = payload;
            controller.enqueue(enc.encode(`data: ${payload}\n\n`));
          }
          if (CLOSING_STAGES.includes(s.stage)) return stop();
        } catch (err) {
          console.error("session events:", err);
        }
        if (!stopped) poll = setTimeout(tick, pollMs);
      };
      void tick();
    },
    cancel() {
      stop();
    },
  });
}
