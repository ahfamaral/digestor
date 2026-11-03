import { OWNER_ID, personAt } from "@digestor/core";
import {
  getPersons, getSession, getTranscript, listAttributions, setHumanAttribution, setHumanAttributions, type Db,
} from "@digestor/core/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

const ms = z.number().int().min(0);
// One range (`startMs`/`endMs`) or several (`ranges`, a row of a person the record names for several turns of a voice).
const range = {
  startMs: ms.optional(), endMs: ms.optional(),
  ranges: z.array(z.object({ startMs: ms, endMs: ms }).strict()).min(1).max(500).optional(),
};
const RECORD_VOICE = "This voice is named part by part from the record. Use \u201cOnly this part\u201d to change one part.";
const speaker = z.string().min(1).max(64);
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), speakerId: speaker, personId: z.string().uuid(), ...range }).strict(),
  z.object({ action: z.literal("create"), speakerId: speaker, displayName: z.string().trim().min(1).max(120), ...range }).strict(),
  z.object({ action: z.literal("anonymous"), speakerId: speaker, ...range }).strict(),
  z.object({ action: z.literal("confirm"), speakerId: speaker }).strict(),
  z.object({ action: z.literal("confirm_all") }).strict(),
]);

async function state(db: Db, sessionId: string) {
  const attributions = await listAttributions(db, sessionId);
  const ids = [...new Set(attributions.map((a) => a.personId).filter((p): p is string => p !== null))];
  return { persons: await getPersons(db, ids), attributions };
}

/** GET /api/sessions/[id]/names — current attributions and the people they mention. */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  return Response.json(await state(db, id));
}

/** POST /api/sessions/[id]/names — a human names, un-names or confirms a voice. */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the change as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Send a valid name change.");
  const body = parsed.data;

  // The ranges a write applies to; `[null]` is a whole-voice write.
  let targets: ({ startMs: number; endMs: number } | null)[] = [];
  if (body.action === "assign" || body.action === "create" || body.action === "anonymous") {
    const single = body.startMs !== undefined || body.endMs !== undefined;
    if (single && body.ranges) return errorResponse(400, "Send one range or a list of ranges, not both.");
    const list = body.ranges ?? (single ? [{ startMs: body.startMs as number, endMs: body.endMs as number }] : [null]);
    if (single && (body.startMs === undefined || body.endMs === undefined)) return errorResponse(400, "Send both start and end, with start before end.");
    if (list.some((r) => r !== null && !(r.startMs < r.endMs))) return errorResponse(400, "Send both start and end, with start before end.");
    targets = list;
  }

  const { db } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  const transcript = await getTranscript(db, id);
  if (!transcript) return errorResponse(409, "Names can be set once the transcript is ready.");

  // A part can't reach past the end of the video.
  const endOfVideo = Math.max(transcript.durationMs, transcript.words.at(-1)?.endMs ?? 0);
  if (targets.some((r) => r !== null && r.endMs > endOfVideo)) return errorResponse(400, "That part is past the end of the video.");

  // A whole-voice human row would shadow the record's per-turn names: refused (inside the lock, in core). The UI scopes its actions to the parts.
  const writeAll = async (speakerId: string, person: { id: string | null } | { create: string }): Promise<Response | null> => {
    const res = await setHumanAttributions(db, { sessionId: id, speakerId, ownerId: OWNER_ID, ranges: targets, person });
    return res.ok ? null : errorResponse(409, RECORD_VOICE);
  };

  switch (body.action) {
    case "assign": {
      if ((await getPersons(db, [body.personId])).length === 0) return errorResponse(404, "Person not found.");
      const refused = await writeAll(body.speakerId, { id: body.personId });
      if (refused) return refused;
      break;
    }
    case "create": {
      // "New person" always creates one: reusing an existing person is what the close-match options (assign) are for.
      const refused = await writeAll(body.speakerId, { create: body.displayName });
      if (refused) return refused;
      break;
    }
    case "anonymous": {
      const refused = await writeAll(body.speakerId, { id: null });
      if (refused) return refused;
      break;
    }
    case "confirm":
    case "confirm_all": {
      // Whole-voice resolution only. A voice with current ranged AI rows is confirmed part by part: a whole-voice human
      // row would shadow those per-turn names. A human ranged row ("Only this part") already beats a whole human row.
      const all = await listAttributions(db, id);
      const isRanged = (a: (typeof all)[number]) => a.startMs !== null && a.endMs !== null;
      const hasRanged = (voice: string) =>
        all.some((a) => a.speakerId === voice && a.supersededAt === null && a.status !== "rejected" && a.source !== "human" && isRanged(a));
      const whole = all.filter((a) => !isRanged(a));
      if (body.action === "confirm" && hasRanged(body.speakerId)) return errorResponse(409, "Confirm each part of this voice separately.");
      const voices = body.action === "confirm" ? [body.speakerId] : [...new Set(transcript.words.map((w) => w.speaker))];
      await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        for (const voice of voices) {
          if (hasRanged(voice)) {
            // "Confirm all" also confirms a part-by-part voice, turn by turn: one ranged human row per proposed turn, grouped by person.
            if (body.action !== "confirm_all") continue;
            // Per span, not per row: a turn named by a ranged row confirms with that row's range; the words a whole-voice
            // proposal names confirm as their contiguous span.
            const perPerson = new Map<string, Map<string, { startMs: number; endMs: number }>>();
            const found: { personId: string; range: { startMs: number; endMs: number } }[] = [];
            const add = (personId: string, range: { startMs: number; endMs: number }) => found.push({ personId, range });
            let open: { personId: string; range: { startMs: number; endMs: number } } | null = null;
            for (const w of transcript.words) {
              if (w.speaker !== voice) {
                open = null;
                continue;
              }
              const res = personAt(all, voice, w.startMs);
              if (res.kind !== "named" || res.confirmed) {
                open = null;
                continue;
              }
              const a = res.attribution;
              if (a.startMs !== null && a.endMs !== null) {
                add(res.personId, { startMs: a.startMs, endMs: a.endMs });
                open = null;
              } else if (open && open.personId === res.personId) {
                open.range.endMs = w.endMs;
              } else {
                open = { personId: res.personId, range: { startMs: w.startMs, endMs: w.endMs } };
                add(res.personId, open.range);
              }
            }
            for (const f of found) {
              const m = perPerson.get(f.personId) ?? new Map();
              m.set(`${f.range.startMs}-${f.range.endMs}`, f.range);
              perPerson.set(f.personId, m);
            }
            for (const [personId, m] of perPerson) {
              await setHumanAttributions(t, { sessionId: id, speakerId: voice, ownerId: OWNER_ID, ranges: [...m.values()], person: { id: personId } });
            }
            continue;
          }
          const res = personAt(whole, voice, 0);
          if (res.kind === "named" && !res.confirmed) {
            await setHumanAttribution(t, { sessionId: id, speakerId: voice, startMs: null, endMs: null, personId: res.personId, ownerId: OWNER_ID });
          }
        }
      });
      break;
    }
  }
  return Response.json(await state(db, id));
}
