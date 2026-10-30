import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type {
  AnalysisBundle, AnalysisVersion, BriefingContent, Moment, MomentChecks, MomentHighlight, MomentWithHighlights, Topic,
} from "../analysisTypes.ts";
import type { Db } from "./client.ts";
import { analysisVersions, briefings, momentHighlights, moments, sessions, topics, translations } from "./schema.ts";
import { PIPELINE_VERSION } from "../pipelineVersion.ts";

export type AnalysisMeta = {
  profile: string;
  reason: string;
  models: Record<string, string>;
  promptVersions: Record<string, string>;
};

export type NewTopic = Pick<Topic, "idx" | "startMs" | "endMs" | "title" | "summary">;

export type NewMoment = Omit<Moment, "id" | "analysisId" | "insideMomentId" | "checks" | "thumbKey" | "ownerId"> & {
  highlights: MomentHighlight[];
  /** Index of the containing moment in the same `saveMoments` array; resolved to an id on insert. */
  insideIdx?: number;
  checks?: MomentChecks | null;
  /** null/undefined = official. */
  ownerId?: string | null;
};

/**
 * Starts the next analysis version, or reuses this session's `running` one (a retry after a crash) after deleting its
 * children. The session row is locked so two concurrent starts can't take the same number.
 */
export async function startAnalysisVersion(
  db: Db,
  sessionId: string,
  meta: AnalysisMeta,
): Promise<{ id: string; version: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${sessions} where ${sessions.id} = ${sessionId} for update`);
    const [running] = await tx
      .select()
      .from(analysisVersions)
      .where(and(eq(analysisVersions.sessionId, sessionId), eq(analysisVersions.status, "running")));
    if (running) {
      await tx.delete(moments).where(eq(moments.analysisId, running.id)); // highlights cascade
      await tx.delete(topics).where(eq(topics.analysisId, running.id));
      await tx.delete(briefings).where(eq(briefings.analysisId, running.id));
      await tx.delete(translations).where(eq(translations.analysisId, running.id));
      await tx
        .update(analysisVersions)
        .set({ profile: meta.profile, reason: meta.reason, models: meta.models, promptVersions: meta.promptVersions })
        .where(eq(analysisVersions.id, running.id));
      return { id: running.id, version: running.version };
    }
    const [max] = await tx
      .select({ v: sql<number>`coalesce(max(${analysisVersions.version}), 0)::int` })
      .from(analysisVersions)
      .where(eq(analysisVersions.sessionId, sessionId));
    const version = (max?.v ?? 0) + 1;
    const [row] = await tx
      .insert(analysisVersions)
      .values({ sessionId, version, status: "running", pipelineVersion: PIPELINE_VERSION, ...meta })
      .returning({ id: analysisVersions.id });
    return { id: row!.id, version };
  });
}

/** Atomically completes the version and makes it the session's only current one. */
export async function completeAnalysisVersion(db: Db, analysisId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(analysisVersions)
      .set({ status: "complete", isCurrent: true })
      .where(eq(analysisVersions.id, analysisId))
      .returning({ sessionId: analysisVersions.sessionId });
    if (!row) throw new Error(`Analysis version not found: ${analysisId}`);
    await tx
      .update(analysisVersions)
      .set({ isCurrent: false })
      .where(and(eq(analysisVersions.sessionId, row.sessionId), ne(analysisVersions.id, analysisId)));
  });
}

export async function failAnalysisVersion(db: Db, analysisId: string): Promise<void> {
  await db.update(analysisVersions).set({ status: "failed" }).where(eq(analysisVersions.id, analysisId));
}

export async function getRunningAnalysis(db: Db, sessionId: string): Promise<AnalysisVersion | null> {
  const [row] = await db
    .select()
    .from(analysisVersions)
    .where(and(eq(analysisVersions.sessionId, sessionId), eq(analysisVersions.status, "running")));
  return row ?? null;
}

/** The session's current complete analysis: topics, official moments (with highlights) and briefing. */
export async function getCurrentAnalysis(db: Db, sessionId: string): Promise<AnalysisBundle | null> {
  const [v] = await db
    .select()
    .from(analysisVersions)
    .where(and(eq(analysisVersions.sessionId, sessionId), eq(analysisVersions.isCurrent, true)));
  if (!v) return null;
  const [topicRows, momentRows, briefingRow] = await Promise.all([
    db.select().from(topics).where(eq(topics.analysisId, v.id)).orderBy(asc(topics.idx)),
    db
      .select()
      .from(moments)
      .where(and(eq(moments.analysisId, v.id), sql`${moments.ownerId} is null`))
      .orderBy(asc(moments.startMs), desc(moments.endMs), asc(moments.id)),
    db.select().from(briefings).where(eq(briefings.analysisId, v.id)),
  ]);
  const highlightRows = await db
    .select({ momentId: momentHighlights.momentId, type: momentHighlights.type, method: momentHighlights.method, value: momentHighlights.value })
    .from(momentHighlights)
    .innerJoin(moments, eq(moments.id, momentHighlights.momentId))
    .where(eq(moments.analysisId, v.id))
    .orderBy(asc(momentHighlights.type));
  const byMoment = new Map<string, MomentHighlight[]>();
  for (const h of highlightRows) {
    const list = byMoment.get(h.momentId) ?? [];
    list.push({ type: h.type, method: h.method, value: h.value });
    byMoment.set(h.momentId, list);
  }
  const withHighlights: MomentWithHighlights[] = momentRows.map((m) => ({ ...m, highlights: byMoment.get(m.id) ?? [] }));
  const b = briefingRow[0];
  return {
    version: { id: v.id, version: v.version, reason: v.reason, status: v.status, createdAt: v.createdAt, profile: v.profile },
    topics: topicRows,
    moments: withHighlights,
    briefing: b ? { lead: b.lead, sections: b.sections } : null,
  };
}

export async function saveTopics(db: Db, analysisId: string, rows: NewTopic[]): Promise<Topic[]> {
  if (rows.length === 0) return [];
  const saved = await db
    .insert(topics)
    .values(rows.map((r) => ({ analysisId, idx: r.idx, startMs: r.startMs, endMs: r.endMs, title: r.title, summary: r.summary })))
    .returning();
  return saved.sort((a, b) => a.idx - b.idx);
}

/** Inserts moments and their highlights; `insideIdx` is resolved against the same array. Returns rows in input order. */
export async function saveMoments(db: Db, analysisId: string, rows: NewMoment[]): Promise<Moment[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(() => randomUUID());
  return db.transaction(async (tx) => {
    const saved = await tx
      .insert(moments)
      .values(
        rows.map((r, i) => {
          const inside = r.insideIdx;
          if (inside !== undefined && (inside < 0 || inside >= rows.length || inside === i)) {
            throw new Error(`insideIdx ${inside} is not a valid parent for moment ${i}`);
          }
          return {
            id: ids[i]!,
            analysisId,
            topicId: r.topicId,
            granularity: r.granularity,
            startMs: r.startMs,
            endMs: r.endMs,
            title: r.title,
            why: r.why,
            relevance: r.relevance,
            speakers: r.speakers,
            insideMomentId: inside === undefined ? null : ids[inside]!,
            evidence: r.evidence,
            checks: r.checks ?? null,
            ownerId: r.ownerId ?? null,
            origin: r.origin,
          };
        }),
      )
      .returning();
    const highlights = rows.flatMap((r, i) => r.highlights.map((h) => ({ momentId: ids[i]!, type: h.type, method: h.method, value: h.value })));
    if (highlights.length > 0) await tx.insert(momentHighlights).values(highlights);
    const byId = new Map(saved.map((m) => [m.id, m]));
    return ids.map((id) => byId.get(id)!);
  });
}

export async function saveBriefing(db: Db, analysisId: string, content: BriefingContent): Promise<void> {
  await db
    .insert(briefings)
    .values({ analysisId, lead: content.lead, sections: content.sections })
    .onConflictDoUpdate({ target: briefings.analysisId, set: { lead: content.lead, sections: content.sections } });
}

export async function setMomentChecks(db: Db, momentId: string, checks: MomentChecks): Promise<void> {
  await db.update(moments).set({ checks }).where(eq(moments.id, momentId));
}

export async function setMomentThumb(db: Db, momentId: string, key: string): Promise<void> {
  await db.update(moments).set({ thumbKey: key }).where(eq(moments.id, momentId));
}

export async function getMoment(db: Db, id: string): Promise<Moment | null> {
  const [row] = await db.select().from(moments).where(eq(moments.id, id));
  return row ?? null;
}

export async function getTranslation(db: Db, analysisId: string, language: string, kind: "briefing"): Promise<unknown | null> {
  const [row] = await db
    .select()
    .from(translations)
    .where(and(eq(translations.analysisId, analysisId), eq(translations.language, language), eq(translations.kind, kind)));
  return row ? row.content : null;
}

export async function saveTranslation(db: Db, analysisId: string, language: string, kind: "briefing", content: unknown): Promise<void> {
  await db
    .insert(translations)
    .values({ analysisId, language, kind, content })
    .onConflictDoUpdate({ target: [translations.analysisId, translations.language, translations.kind], set: { content } });
}
