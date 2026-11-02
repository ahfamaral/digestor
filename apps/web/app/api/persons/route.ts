import { searchPersons } from "@digestor/core/server";
import { getServer } from "@/lib/server";

/** GET /api/persons?q= — people whose name contains the query (2+ characters, at most 10). */
export async function GET(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ persons: [] });
  return Response.json({ persons: await searchPersons(getServer().db, q, 10) });
}
