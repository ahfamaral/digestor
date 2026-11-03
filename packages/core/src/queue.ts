import { z } from "zod";
import { LANGUAGES, ProfileIdSchema } from "./profiles.ts";
import { ResumePayloadSchema } from "./schemas.ts";

export const QUEUES = {
  start: "session.start",
  resume: "session.resume",
  reanalyze: "session.reanalyze",
  checkMoment: "moment.check",
  prepareTrack: "track.prepare",
  burnTrack: "track.burn",
  renderClip: "clip.render",
  translateBriefing: "briefing.translate",
  ask: "ask.run",
  findMore: "moment.find_more",
  names: "session.names",
  proxy: "session.proxy",
} as const;

export const StartJobSchema = z.object({ sessionId: z.string().uuid() });
export type StartJob = z.infer<typeof StartJobSchema>;

export const ResumeJobSchema = z.object({ sessionId: z.string().uuid(), payload: ResumePayloadSchema });
export type ResumeJob = z.infer<typeof ResumeJobSchema>;

/** A new analysis version of a `ready` session, e.g. with a corrected profile. */
export const ReanalyzeJobSchema = z.object({
  sessionId: z.string().uuid(),
  profile: ProfileIdSchema,
  reason: z.string().trim().min(1).max(500),
  /** The `running` version the web route claimed for this job; absent in older payloads (the worker then starts one). */
  analysisId: z.string().uuid().optional(),
});
export type ReanalyzeJob = z.infer<typeof ReanalyzeJobSchema>;

export const CheckMomentJobSchema = z.object({ momentId: z.string().uuid() });
export type CheckMomentJob = z.infer<typeof CheckMomentJobSchema>;

export const PrepareTrackJobSchema = z.object({ trackId: z.string().uuid() });
export type PrepareTrackJob = z.infer<typeof PrepareTrackJobSchema>;

export const BurnTrackJobSchema = z.object({ trackId: z.string().uuid() });
export type BurnTrackJob = z.infer<typeof BurnTrackJobSchema>;

export const RenderClipJobSchema = z.object({ clipId: z.string().uuid() });
export type RenderClipJob = z.infer<typeof RenderClipJobSchema>;

export const TranslateBriefingJobSchema = z.object({
  analysisId: z.string().uuid(),
  language: z.string().refine((code) => LANGUAGES.some((l) => l.code === code), "unsupported language"),
});
export type TranslateBriefingJob = z.infer<typeof TranslateBriefingJobSchema>;

export const AskJobSchema = z.object({ messageId: z.string().uuid() });
export type AskJob = z.infer<typeof AskJobSchema>;

export const FindMoreJobSchema = z.object({ requestId: z.string().uuid() });
export type FindMoreJob = z.infer<typeof FindMoreJobSchema>;

/** Match a session's linked official record against its transcript (names from the Senado or Câmara record). */
export const NamesJobSchema = z.object({ sessionId: z.string().uuid() });
export type NamesJob = z.infer<typeof NamesJobSchema>;

/** Encode the session's 480p preview copy (`proxy.mp4`) from its original; the pipeline does not wait for it. */
export const ProxyJobSchema = z.object({ sessionId: z.string().uuid() });
export type ProxyJob = z.infer<typeof ProxyJobSchema>;

/**
 * The one source of pg-boss options: the worker applies them to every queue (create + update) and every sender
 * passes them to `send`, so new and pre-existing queues behave the same.
 * - retryLimit/retryDelay: a failed or crashed job is retried twice, 30 s apart.
 * - heartbeatSeconds: the worker refreshes a running job's heartbeat (every 30 s); a job whose worker died
 *   (kill -9, OOM, reboot) is retried after 60 s without one instead of staying active until it expires.
 * - expireInSeconds: 12 h, so long transcriptions and renders never expire mid-run.
 */
export const JOB_OPTIONS = { retryLimit: 2, retryDelay: 30, expireInSeconds: 43200, heartbeatSeconds: 60 } as const;
