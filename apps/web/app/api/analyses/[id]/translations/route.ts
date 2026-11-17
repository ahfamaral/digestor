import { z } from "zod";
import { JOB_OPTIONS, LANGUAGES, OWNER_ID, QUEUES } from "@digestor/core";
import { deletePendingTranslation, getAnalysisVersion, getSession, getTranslation, requestTranslation } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ language: z.string() }).strict();
const isOffered = (code: string) => LANGUAGES.some((l) => l.code === code);
const NOT_OFFERED = "That language isn't available.";

async function ownedAnalysis(id: string) {
  const { db } = getServer();
  const version = isUuid(id) ? await getAnalysisVersion(db, id) : null;
  const session = version ? await getSession(db, version.sessionId) : null;
  return version && session && session.ownerId === OWNER_ID ? version : null;
}

/** GET /api/analyses/[id]/translations?language=xx — 200 `{ status, content?, error? }`, or 404 when never requested. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!(await ownedAnalysis(id))) return errorResponse(404, "Briefing not found.");
  const language = new URL(request.url).searchParams.get("language") ?? "";
  if (!isOffered(language)) return errorResponse(400, NOT_OFFERED);
  const row = await getTranslation(getServer().db, id, language, "briefing");
  if (!row) return errorResponse(404, "This briefing hasn't been translated yet.");
  return Response.json({
    status: row.status,
    ...(row.status === "ready" ? { content: row.content } : {}),
    ...(row.error ? { error: row.error } : {}),
  });
}

/** POST /api/analyses/[id]/translations — `{ language }`: returns a finished translation (200) or queues one (202). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the language as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success || !isOffered(parsed.data.language)) return errorResponse(400, NOT_OFFERED);
  const { language } = parsed.data;

  const version = await ownedAnalysis(id);
  if (!version) return errorResponse(404, "Briefing not found.");
  if (version.status !== "complete") return errorResponse(409, "This briefing isn't ready yet.");

  const { db, boss } = getServer();
  const existing = await getTranslation(db, id, language, "briefing");
  if (existing?.status === "ready") return Response.json({ status: "ready", content: existing.content });

  // Claim first, then send: a second request while one is pending (a double click, another tab) sends nothing, and
  // never rolls back the first request's row. A pending row whose job died is failed by the sweep, then claimable again.
  if (!(await requestTranslation(db, id, language, "briefing"))) {
    const now = await getTranslation(db, id, language, "briefing");
    if (now?.status === "ready") return Response.json({ status: "ready", content: now.content });
    return Response.json({ status: "pending" }, { status: 202 });
  }
  try {
    await boss.send(QUEUES.translateBriefing, { analysisId: id, language }, JOB_OPTIONS);
  } catch (err) {
    console.error("translations: enqueue failed", err);
    await deletePendingTranslation(db, id, language, "briefing").catch((e: unknown) => console.error("translations: rollback failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ status: "pending" }, { status: 202 });
}
