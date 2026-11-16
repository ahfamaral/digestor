import { asc, eq, sql } from "drizzle-orm";
import type { LLMUsage } from "../analysisTypes.ts";
import type { SpendingInput } from "../cost.ts";
import type { Db } from "./client.ts";
import { analysisVersions, sessions, transcripts } from "./schema.ts";

/** One session's spending facts (`sessionSpending` turns them into dollars). */
export type SpendingRow = SpendingInput & { sessionId: string };

/**
 * Every session's spending facts, for the Sessions page total: its length (the transcript's when the session row has
 * none), whether a transcript was stored, and the usage of each analysis version. Two queries, no per-session loop.
 */
export async function listSpendingRows(db: Db): Promise<SpendingRow[]> {
  const [rows, versions] = await Promise.all([
    db
      .select({
        sessionId: sessions.id,
        durationMs: sql<number | null>`coalesce(${sessions.durationMs}, ${transcripts.durationMs})`,
        hasVideo: sessions.hasVideo,
        transcribed: sql<boolean>`${transcripts.sessionId} is not null`,
      })
      .from(sessions)
      .leftJoin(transcripts, eq(transcripts.sessionId, sessions.id)),
    db
      .select({ sessionId: analysisVersions.sessionId, usage: analysisVersions.usage })
      .from(analysisVersions)
      .orderBy(asc(analysisVersions.version)),
  ]);
  const bySession = new Map<string, { usage: LLMUsage }[]>();
  for (const v of versions) bySession.set(v.sessionId, [...(bySession.get(v.sessionId) ?? []), { usage: v.usage }]);
  return rows.map((r) => ({
    sessionId: r.sessionId,
    durationMs: r.durationMs === null ? null : Number(r.durationMs),
    hasVideo: r.hasVideo,
    transcribed: Boolean(r.transcribed),
    analyses: bySession.get(r.sessionId) ?? [],
  }));
}
