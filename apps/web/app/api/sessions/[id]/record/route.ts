import { z } from "zod";
import { JOB_OPTIONS, QUEUES, recordRefDate, type RecordRef } from "@digestor/core";
import { acceptSuggestedRecord, dismissSuggestedRecord, getSession, getSessionRecord, getTranscript, linkRecord } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { t } from "@/lib/i18n";
import { readRecordInput } from "@/lib/recordInput";
import { QUEUE_FAILED } from "@/lib/personal";
import { getServer } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

const BodySchema = z.object({ ref: z.string(), chamber: z.unknown().optional() }).strict();
/** Accept or dismiss a suggestion: `ref` is the suggested ref as GET returned it, so the compare-and-set checks what the journalist saw. */
const ActionSchema = z.object({ action: z.enum(["accept", "dismiss"]), ref: z.object({ chamber: z.string() }).passthrough() }).strict();

/** GET /api/sessions/[id]/record — `{ status, error, chamber, date, url, retryAt }` of the linked record (date as DD/MM/YYYY, null for a ref without one; retryAt ISO or null; a `suggested` row adds its `ref`), or null when none is linked. Who's who polls it. */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  const row = await getSessionRecord(db, id);
  if (!row) return Response.json(null);
  return Response.json({ status: row.status, error: row.error, chamber: row.ref.chamber, date: recordRefDate(row.ref), url: row.ref.url, retryAt: row.retryAt?.toISOString() ?? null, ...(row.status === "suggested" ? { ref: row.ref } : {}) });
}

/**
 * POST /api/sessions/[id]/record — `{ ref, chamber? }`: links (the house picked, else the one the link names) the Senado record (a date, or a session link with its date) or the Câmara record (an event link) and
 * matches speakers to its speeches. 202. The link is stored first; then, when the transcript exists, `session.names`
 * is sent (the claim lives in the job, so a double send is harmless). Without a transcript the pipeline's
 * `match_record` step picks the row up. Works after the video was removed: names need no video.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const body: unknown = await request.json().catch(() => null);
  const act = ActionSchema.safeParse(body);
  if (act.success) return suggestion(id, act.data.action, act.data.ref as unknown as RecordRef);
  if (body && typeof body === "object" && "action" in body) return errorResponse(400, t("record.invalid"));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return errorResponse(400, t("record.invalid"));
  const read = readRecordInput(parsed.data.ref, parsed.data.chamber);
  if ("error" in read) return read.error;
  const ref = read.ref;
  if (!ref) return errorResponse(400, t("record.invalid"));

  const { db, boss } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  // Link first, then look for the transcript: a link made just as transcription finishes is seen by the job or by the graph.
  await linkRecord(db, id, ref);
  if (await getTranscript(db, id)) {
    try {
      await boss.send(QUEUES.names, { sessionId: id }, JOB_OPTIONS);
    } catch (err) {
      console.error("record: enqueue failed", err);
      return errorResponse(503, QUEUE_FAILED);
    }
  }
  return Response.json({ status: "pending" }, { status: 202 });
}

/**
 * `accept`: `suggested` → `pending` for exactly the ref the journalist saw (409 when it changed). `session.names` is sent
 * only when the transcript exists and the session is past the context check: at `awaiting_context` the graph's second
 * record step (`match_record_late`) matches it on Continue, and before the transcript the first one does.
 * `dismiss`: deletes the suggested row (200).
 */
async function suggestion(id: string, action: "accept" | "dismiss", ref: RecordRef): Promise<Response> {
  const { db, boss } = getServer();
  const session = await getSession(db, id);
  if (!session) return errorResponse(404, "Session not found.");
  const changed = errorResponse(409, t("record.suggestionChanged"));
  if (action === "dismiss") return (await dismissSuggestedRecord(db, id, ref)) ? Response.json({ status: "dismissed" }) : changed;
  if (!(await acceptSuggestedRecord(db, id, ref))) return changed;
  if (session.stage !== "awaiting_context" && (await getTranscript(db, id))) {
    try {
      await boss.send(QUEUES.names, { sessionId: id }, JOB_OPTIONS);
    } catch (err) {
      console.error("record: enqueue failed", err);
      return errorResponse(503, QUEUE_FAILED);
    }
  }
  return Response.json({ status: "pending" }, { status: 202 });
}
