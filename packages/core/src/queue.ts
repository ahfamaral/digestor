import { z } from "zod";
import { ResumePayloadSchema } from "./schemas.js";

export const QUEUES = { start: "session.start", resume: "session.resume", renderClip: "clip.render" } as const;

export const StartJobSchema = z.object({ sessionId: z.string().uuid() });
export type StartJob = z.infer<typeof StartJobSchema>;

export const ResumeJobSchema = z.object({ sessionId: z.string().uuid(), payload: ResumePayloadSchema });
export type ResumeJob = z.infer<typeof ResumeJobSchema>;

export const RenderClipJobSchema = z.object({ clipId: z.string().uuid() });
export type RenderClipJob = z.infer<typeof RenderClipJobSchema>;

/** pg-boss send options shared by every sender, so a crashed/failed job is retried. */
export const JOB_OPTIONS = { retryLimit: 2, retryDelay: 30 } as const;
