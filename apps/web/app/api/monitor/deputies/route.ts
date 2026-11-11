import { normName } from "@digestor/core";
import { searchMembers } from "@digestor/core/server";
import { cleanQuery } from "@/lib/monitor/search";
import { getServer } from "@/lib/server";

const SHOWN = 8;

/**
 * GET /api/monitor/deputies?q= — the deputy combobox's suggestions: up to 8 deputies whose name contains the query
 * (2+ letters after cleaning), and `more` when there are others. Behind the password gate (middleware, 401 JSON).
 */
export async function GET(request: Request): Promise<Response> {
  const q = cleanQuery(new URL(request.url).searchParams.get("q") ?? "");
  if (normName(q).length < 2) return Response.json({ rows: [], more: false });
  const found = await searchMembers(getServer().db, q, SHOWN + 1);
  return Response.json({
    rows: found.slice(0, SHOWN).map((m) => ({
      externalId: m.externalId, name: m.name, party: m.party, uf: m.uf, photoUrl: m.photoUrl, inOffice: m.inOffice,
    })),
    more: found.length > SHOWN,
  });
}
