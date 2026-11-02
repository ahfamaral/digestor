import { OWNER_ID, personAt } from "@digestor/core";
import {
  createCustomPerson, findPersonByName, getPersons, getSession, getTranscript, listAttributions, setHumanAttribution, type Db,
} from "@digestor/core/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

const range = { startMs: z.number().int().min(0).optional(), endMs: z.number().int().min(0).optional() };
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

  let startMs: number | null = null;
  let endMs: number | null = null;
  if (body.action === "assign" || body.action === "create" || body.action === "anonymous") {
    if ((body.startMs === undefined) !== (body.endMs === undefined) || (body.startMs !== undefined && body.endMs !== undefined && body.startMs >= body.endMs)) {
      return errorResponse(400, "Send both start and end, with start before end.");
    }
    startMs = body.startMs ?? null;
    endMs = body.endMs ?? null;
  }

  const { db } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  const transcript = await getTranscript(db, id);
  if (!transcript) return errorResponse(409, "Names can be set once the transcript is ready.");

  const write = (speakerId: string, personId: string | null, s: number | null, e: number | null) =>
    setHumanAttribution(db, { sessionId: id, speakerId, startMs: s, endMs: e, personId, ownerId: OWNER_ID });

  switch (body.action) {
    case "assign": {
      if ((await getPersons(db, [body.personId])).length === 0) return errorResponse(404, "Person not found.");
      await write(body.speakerId, body.personId, startMs, endMs);
      break;
    }
    case "create": {
      const person =
        (await findPersonByName(db, body.displayName)) ?? (await createCustomPerson(db, { displayName: body.displayName, createdBy: OWNER_ID }));
      await write(body.speakerId, person.id, startMs, endMs);
      break;
    }
    case "anonymous":
      await write(body.speakerId, null, startMs, endMs);
      break;
    case "confirm":
    case "confirm_all": {
      // Whole-voice resolution only. A voice with current ranged rows is confirmed part by part: a whole-voice human row
      // would shadow the per-turn names.
      const all = await listAttributions(db, id);
      const isRanged = (a: (typeof all)[number]) => a.startMs !== null && a.endMs !== null;
      const hasRanged = (voice: string) => all.some((a) => a.speakerId === voice && a.supersededAt === null && a.status !== "rejected" && isRanged(a));
      const whole = all.filter((a) => !isRanged(a));
      if (body.action === "confirm" && hasRanged(body.speakerId)) return errorResponse(409, "Confirm each part of this voice separately.");
      const voices = body.action === "confirm" ? [body.speakerId] : [...new Set(transcript.words.map((w) => w.speaker))].filter((v) => !hasRanged(v));
      for (const voice of voices) {
        const res = personAt(whole, voice, 0);
        if (res.kind === "named" && !res.confirmed) await write(voice, res.personId, null, null);
      }
      break;
    }
  }
  return Response.json(await state(db, id));
}
