import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { normaliseName, turnsOf, type Word } from "@digestor/core";
import type { LocalStorage } from "@digestor/core/server";
import { MissingApiKeyError } from "../errors.js";
import type { StructuredLLM } from "../llm/structured.js";
import { mapPool, PASS_CONCURRENCY } from "./moments.js";

export const CAPTION_MIN_TURN_MS = 8_000;
export const CAPTION_FRAMES_PER_VOICE = 6;
export const CAPTION_MAX_FRAMES = 60;
export const CAPTION_WIDTH = 1280;
const TURNS_PER_VOICE = CAPTION_FRAMES_PER_VOICE / 2;
/** Lower thirds usually appear as a speaker starts: one frame early in the turn, one a little later. */
const FRAME_OFFSETS_MS = [1_000, 4_000];

/**
 * Frames to read for each voice: its first 3 turns of at least 8 s, at +1 s and +4 s into each turn.
 * Voices that speak longest come first; at most 60 frames in all.
 */
export function captionFramePlan(words: Word[]): { speakerId: string; atMs: number }[] {
  const spoken = new Map<string, number>();
  const longTurns = new Map<string, number[]>(); // start of each long turn, in time order
  for (const t of turnsOf(words)) {
    spoken.set(t.speakerId, (spoken.get(t.speakerId) ?? 0) + (t.endMs - t.startMs));
    if (t.endMs - t.startMs < CAPTION_MIN_TURN_MS) continue;
    const starts = longTurns.get(t.speakerId) ?? [];
    if (starts.length < TURNS_PER_VOICE) starts.push(t.startMs);
    longTurns.set(t.speakerId, starts);
  }
  const voices = [...longTurns.keys()].sort((a, b) => spoken.get(b)! - spoken.get(a)!);
  return voices
    .flatMap((speakerId) => longTurns.get(speakerId)!.flatMap((s) => FRAME_OFFSETS_MS.map((o) => ({ speakerId, atMs: s + o }))))
    .slice(0, CAPTION_MAX_FRAMES);
}

/** Lenient: "" means nothing was read; a malformed field degrades to "" instead of failing the call. */
export const CaptionOutput: z.ZodType<{ captionText: string; personName: string; partyOrRole: string }> = z.object({
  captionText: z.string().catch(""),
  personName: z.string().catch(""),
  partyOrRole: z.string().catch(""),
}) as unknown as z.ZodType<{ captionText: string; personName: string; partyOrRole: string }>; // `.catch` widens the input type only

const CAPTION_SYSTEM = [
  "You read the on-screen caption (lower third, name strap) in one video frame.",
  "Read only text visible in the image; never guess.",
  "captionText: the caption text as written. personName: the name of the person as written in the caption (the full name when shown). partyOrRole: a party, role or title shown with the name.",
  "A caption names one person. If the frame shows several names (a debate timer, a scoreboard, a list of candidates), it does not say who is speaking: leave personName empty.",
  "Use an empty string for anything that is not visible, and for all three when the frame has no caption.",
].join("\n");

const orNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());

export async function readCaption(
  llm: StructuredLLM,
  image: { mediaType: "image/jpeg"; data: string },
): Promise<{ text: string | null; name: string | null; partyOrRole: string | null }> {
  const out = await llm.generate({
    schema: CaptionOutput,
    name: "captions",
    system: CAPTION_SYSTEM,
    user: "What does the caption in this frame say, and who is it naming?",
    model: "fast",
    images: [image],
  });
  return { text: orNull(out.captionText), name: orNull(out.personName), partyOrRole: orNull(out.partyOrRole) };
}

export type CaptionRead = { speakerId: string; atMs: number; frameKey: string; name: string | null; text: string | null };
export type CaptionVote = { speakerId: string; name: string; frameKey: string; text: string; atMs: number; agreeing: number; total: number };

/**
 * A voice's name: the same name (accents and case ignored) in at least 2 of its frames, and no other name in any frame.
 * `total` is every frame read for the voice; the first agreeing frame is the evidence.
 */
export function captionVotes(reads: CaptionRead[]): CaptionVote[] {
  const byVoice = new Map<string, CaptionRead[]>();
  for (const r of reads) byVoice.set(r.speakerId, [...(byVoice.get(r.speakerId) ?? []), r]);
  const votes: CaptionVote[] = [];
  for (const [speakerId, rs] of byVoice) {
    const named = rs.filter((r) => r.name !== null && normaliseName(r.name) !== "");
    const distinct = new Set(named.map((r) => normaliseName(r.name!)));
    if (distinct.size !== 1 || named.length < 2) continue;
    const first = [...named].sort((a, b) => a.atMs - b.atMs)[0]!;
    votes.push({
      speakerId, name: first.name!, frameKey: first.frameKey, text: first.text ?? first.name!, atMs: first.atMs,
      agreeing: named.length, total: rs.length,
    });
  }
  return votes;
}

export type CaptionDeps = {
  llm: StructuredLLM;
  storage: Pick<LocalStorage, "key" | "resolve">;
  media: { frame(input: string, atMs: number, output: string, width: number): Promise<unknown> };
};

/**
 * Frame plan → frames from the original video (kept under `<sessionId>/names/` as evidence) → one vision call each.
 * A frame that cannot be cut or read is skipped; only a missing API key stops the step.
 */
export async function readCaptions(deps: CaptionDeps, sessionId: string, videoKey: string, words: Word[]): Promise<CaptionRead[]> {
  const plan = captionFramePlan(words);
  const input = deps.storage.resolve(videoKey);
  const reads = await mapPool(plan, PASS_CONCURRENCY, async (p): Promise<CaptionRead | null> => {
    const frameKey = deps.storage.key(sessionId, `names/${p.speakerId.replace(/[^\w-]/g, "_")}-${p.atMs}.jpg`);
    const file = deps.storage.resolve(frameKey);
    try {
      await deps.media.frame(input, p.atMs, file, CAPTION_WIDTH);
      const data = (await readFile(file)).toString("base64");
      const r = await readCaption(deps.llm, { mediaType: "image/jpeg", data });
      return { speakerId: p.speakerId, atMs: p.atMs, frameKey, name: r.name, text: r.text };
    } catch (err) {
      if (err instanceof MissingApiKeyError) throw err;
      console.error(`captions: skipped the frame at ${p.atMs} ms of voice ${p.speakerId} (session ${sessionId})`, err);
      await rm(file, { force: true });
      return null;
    }
  });
  return reads.filter((r): r is CaptionRead => r !== null);
}
