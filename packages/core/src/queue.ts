import { z } from "zod";
import { ResumePayloadSchema } from "./schemas.js";

export const QUEUES = { start: "session.start", resume: "session.resume", renderClip: "clip.render" } as const;

export const StartJobSchema = z.object({ sessionId: z.string().uuid() });
export type StartJob = z.infer<typeof StartJobSchema>;

export const ResumeJobSchema = z.object({ sessionId: z.string().uuid(), payload: ResumePayloadSchema });
export type ResumeJob = z.infer<typeof ResumeJobSchema>;

export const RenderClipJobSchema = z.object({ clipId: z.string().uuid() });
export type RenderClipJob = z.infer<typeof RenderClipJobSchema>;
