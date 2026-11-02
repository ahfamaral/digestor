import { z } from "zod";
import { JOB_OPTIONS, OWNER_ID, PROFILES, QUEUES } from "@digestor/core";
import { failFindMore, getCurrentAnalysis, getFindMore, getTranscript, requestFindMore } from "@digestor/core/server";
import { focusOptions } from "@/lib/briefingData";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { loadNames } from "@/lib/namesServer";
import { QUEUE_FAILED, readySession } from "@/lib/personal";
import { asProfile } from "@/lib/preview";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ personId: z.string().uuid() }).strict();
const RUNNING = "Already looking for more moments with this person.";
const NO_PERSON = "That person isn't named in this video.";

/** GET /api/sessions/[id]/find-more?personId= — `{ status, momentCount, error, requestId }`; status "none" when never asked for this person. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const personId = new URL(request.url).searchParams.get("personId") ?? "";
  if (!isUuid(id) || !isUuid(personId)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  const bundle = await getCurrentAnalysis(db, id);
  const row = bundle ? await getFindMore(db, { ownerId: OWNER_ID, analysisId: bundle.version.id, personId }) : null;
  return Response.json({ status: row?.status ?? "none", momentCount: row?.momentCount ?? 0, error: row?.error ?? null, requestId: row?.id ?? null });
}

/**
 * POST /api/sessions/[id]/find-more — `{ personId }`: looks for more moments with that person in the current analysis
 * (one paid text call in the worker). 202 `{ status: "pending" }`; 409 while one is pending or running. The request is
 * claimed in the database first, then sent; a failed send marks the row failed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the person as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, NO_PERSON);

  const { db, boss } = getServer();
  const ready = await readySession(db, id);
  if ("error" in ready) return ready.error;
  const bundle = await getCurrentAnalysis(db, id);
  if (!bundle) return errorResponse(409, "This video isn't ready yet.");

  // Only a person the Focus picker lists: in a sensitive profile an unconfirmed name is not one.
  const [names, transcript] = await Promise.all([loadNames(db, id), getTranscript(db, id)]);
  const sensitive = PROFILES[asProfile(bundle.version.profile)].sensitive;
  if (!focusOptions(names, transcript?.words ?? [], sensitive).some((o) => o.kind === "person" && o.personId === parsed.data.personId)) {
    return errorResponse(404, NO_PERSON);
  }

  const row = await requestFindMore(db, { ownerId: OWNER_ID, analysisId: bundle.version.id, personId: parsed.data.personId });
  if (!row) return errorResponse(409, RUNNING);
  try {
    await boss.send(QUEUES.findMore, { requestId: row.id }, JOB_OPTIONS);
  } catch (err) {
    console.error("find-more: enqueue failed", err);
    await failFindMore(db, row.id, QUEUE_FAILED).catch((e: unknown) => console.error("find-more: rollback failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ status: "pending" }, { status: 202 });
}
