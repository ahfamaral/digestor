import { z } from "zod";
import { OWNER_ID } from "@digestor/core";
import { addProblemReport, getSession } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { getServer } from "@/lib/server";

const BodySchema = z
  .object({
    sessionId: z.string().uuid(),
    targetKind: z.enum(["moment", "topic", "briefing", "quote", "clip", "track", "attribution"]),
    targetId: z.string().trim().min(1).max(100),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

/** POST /api/reports — "Report a problem": `{ sessionId, targetKind, targetId, note? }` → 201. */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the report as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Tell us which part has a problem (the note is optional, up to 1000 characters).");
  const { db } = getServer();
  const session = await getSession(db, parsed.data.sessionId);
  if (!session || session.ownerId !== OWNER_ID) return errorResponse(404, "Session not found.");
  const report = await addProblemReport(db, { ownerId: OWNER_ID, ...parsed.data, note: parsed.data.note ?? "" });
  return Response.json(report, { status: 201 });
}
