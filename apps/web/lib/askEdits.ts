import { z } from "zod";
import { LANGUAGES, parseTimestamp, type ToolApprovalPayload } from "@digestor/core";

/** What the edit is checked against besides the card: the video's own language is a subtitle language too. */
export type EditContext = { sessionLanguage: string | null };

function toMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  try {
    return parseTimestamp(v);
  } catch {
    return null;
  }
}
const Time = z.string().refine((v) => toMs(v) !== null);
const ClipTimes = z.object({ start: z.unknown(), end: z.unknown() }).refine((a) => {
  const start = toMs(a.start);
  const end = toMs(a.end);
  return start !== null && end !== null && end > start;
});
const ClipTitle = z.string().trim().min(1).max(120);
const ClipEdit = z.object({ start: Time, end: Time, title: ClipTitle }).strict().and(ClipTimes);

const countOf = (original: unknown, key: string): number => {
  const v = (original as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? v.length : 0;
};

/**
 * What the card may edit, per tool: times and title of a clip, which moments of a selection, and for a package which
 * clips to make (never more than the card offered), their times and titles, the format and the subtitle language.
 * Ids and status stay as the model sent them.
 */
const EDIT_SCHEMAS: Record<string, (original: unknown, ctx: EditContext) => z.ZodType<unknown>> = {
  propose_clip: () => ClipEdit,
  trim_clip: () => z.object({ start: Time, end: Time }).strict().and(ClipTimes),
  set_selection: (original) => {
    const allowed = new Set(((original as { momentIds?: unknown } | null)?.momentIds as string[] | undefined) ?? []);
    return z.object({ momentIds: z.array(z.string()).min(1).max(200).refine((ids) => ids.every((id) => allowed.has(id))) }).strict();
  },
  make_clip_package: (original, ctx) =>
    z
      .object({
        clips: z.array(ClipEdit).min(1).max(Math.max(1, countOf(original, "clips"))),
        format: z.enum(["16:9", "9:16"]),
        subtitles: z
          .string()
          .nullable()
          .refine((code) => code === null || LANGUAGES.some((l) => l.code === code) || code === ctx.sessionLanguage),
      })
      .strict(),
};

/** The edits checked against the card's calls (the stored payload): each edits one call on it, with the arguments its tool allows. */
export function readEdits(payload: ToolApprovalPayload, edits: { id: string; args: unknown }[], ctx: EditContext): { id: string; args: unknown }[] | null {
  const out: { id: string; args: unknown }[] = [];
  for (const edit of edits) {
    const call = payload.calls.find((c) => c.id === edit.id);
    const schema = call ? EDIT_SCHEMAS[call.name]?.(call.args, ctx) : undefined;
    const parsed = schema?.safeParse(edit.args);
    if (!parsed?.success || out.some((e) => e.id === edit.id)) return null;
    out.push({ id: edit.id, args: parsed.data });
  }
  return out;
}
