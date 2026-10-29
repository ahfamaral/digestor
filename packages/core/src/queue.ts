import { z } from "zod";
import { ResumePayloadSchema } from "./schemas.ts";

export const QUEUES = { start: "session.start", resume: "session.resume", renderClip: "clip.render" } as const;

export const StartJobSchema = z.object({ sessionId: z.string().uuid() });
export type StartJob = z.infer<typeof StartJobSchema>;

export const ResumeJobSchema = z.object({ sessionId: z.string().uuid(), payload: ResumePayloadSchema });
export type ResumeJob = z.infer<typeof ResumeJobSchema>;

export const RenderClipJobSchema = z.object({ clipId: z.string().uuid() });
export type RenderClipJob = z.infer<typeof RenderClipJobSchema>;

/**
 * The one source of pg-boss options: the worker applies them to every queue (create + update) and every sender
 * passes them to `send`, so new and pre-existing queues behave the same.
 * - retryLimit/retryDelay: a failed or crashed job is retried twice, 30 s apart.
 * - heartbeatSeconds: the worker refreshes a running job's heartbeat (every 30 s); a job whose worker died
 *   (kill -9, OOM, reboot) is retried after 60 s without one instead of staying active until it expires.
 * - expireInSeconds: 12 h, so long transcriptions and renders never expire mid-run.
 */
export const JOB_OPTIONS = { retryLimit: 2, retryDelay: 30, expireInSeconds: 43200, heartbeatSeconds: 60 } as const;
