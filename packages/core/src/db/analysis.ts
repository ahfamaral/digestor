import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type {
  LLMUsage,
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

/**
 * Claims a re-analysis: under an advisory lock for the session, inserts the next `running` version row, or returns
 * null when one is already running. Lets the web route refuse a double click before any paid job is queued; the
 * worker then fills the claimed version (`startAnalysisVersion` reuses a running one).
 */
export async function claimAnalysisVersion(
  db: Db,
  sessionId: string,
  meta: Pick<AnalysisMeta, "profile" | "reason">,
): Promise<{ id: string; version: number } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
    await tx.execute(sql`select id from ${sessions} where ${sessions.id} = ${sessionId} for update`);
    const [running] = await tx
      .select({ id: analysisVersions.id })
      .from(analysisVersions)
      .where(and(eq(analysisVersions.sessionId, sessionId), eq(analysisVersions.status, "running")));
    if (running) return null;
    const [max] = await tx
      .select({ v: sql<number>`coalesce(max(${analysisVersions.version}), 0)::int` })
      .from(analysisVersions)
      .where(eq(analysisVersions.sessionId, sessionId));
    const version = (max?.v ?? 0) + 1;
    const [row] = await tx
      .insert(analysisVersions)
      .values({ sessionId, version, status: "running", pipelineVersion: PIPELINE_VERSION, models: {}, promptVersions: {}, ...meta })
      .returning({ id: analysisVersions.id });
    return { id: row!.id, version };
  });
}

/**
 * Atomically completes a `running` version and makes it the session's only current one. Takes the same session row
 * lock as `startAnalysisVersion`, so concurrent completes of two versions serialise instead of deadlocking.
 * Throws when the version is missing or not running (a failed or already complete version never becomes current).
 * `usage` is the LLM usage of the run that completed it.
 */
export async function completeAnalysisVersion(db: Db, analysisId: string, opts: { usage?: LLMUsage } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ sessionId: analysisVersions.sessionId })
      .from(analysisVersions)
      .where(eq(analysisVersions.id, analysisId));
    if (!found) throw new Error(`Analysis version not found: ${analysisId}`);
    await tx.execute(sql`select id from ${sessions} where ${sessions.id} = ${found.sessionId} for update`);
    const [row] = await tx
      .update(analysisVersions)
      .set({ status: "complete", isCurrent: true, ...(opts.usage ? { usage: opts.usage } : {}) })
      .where(and(eq(analysisVersions.id, analysisId), eq(analysisVersions.status, "running")))
      .returning({ sessionId: analysisVersions.sessionId });
    if (!row) throw new Error(`Analysis version is not running: ${analysisId}`);
    await tx
      .update(analysisVersions)
      .set({ isCurrent: false })
      .where(and(eq(analysisVersions.sessionId, row.sessionId), ne(analysisVersions.id, analysisId)));
  });
}

/**
 * Makes a complete version the session's current one again (the evaluation batch puts back the version the session
 * had before its runs). Same session row lock as `completeAnalysisVersion`. False when the version is missing, not
 * this session's, or not complete; nothing changes then.
 */
export async function makeAnalysisCurrent(db: Db, sessionId: string, analysisId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${sessions} where ${sessions.id} = ${sessionId} for update`);
    const [row] = await tx
      .update(analysisVersions)
      .set({ isCurrent: true })
      .where(and(eq(analysisVersions.id, analysisId), eq(analysisVersions.sessionId, sessionId), eq(analysisVersions.status, "complete")))
      .returning({ id: analysisVersions.id });
    if (!row) return false;
    await tx
      .update(analysisVersions)
      .set({ isCurrent: false })
      .where(and(eq(analysisVersions.sessionId, sessionId), ne(analysisVersions.id, analysisId)));
    return true;
  });
}

/** Marks a `running` version failed. Returns false (and changes nothing) for a missing, complete or failed version. */
export async function failAnalysisVersion(db: Db, analysisId: string): Promise<boolean> {
  const rows = await db
    .update(analysisVersions)
    .set({ status: "failed" })
    .where(and(eq(analysisVersions.id, analysisId), eq(analysisVersions.status, "running")))
    .returning({ id: analysisVersions.id });
  return rows.length > 0;
}

export async function getAnalysisVersion(db: Db, analysisId: string): Promise<AnalysisVersion | null> {
  const [row] = await db.select().from(analysisVersions).where(eq(analysisVersions.id, analysisId));
  return row ?? null;
}

/** Every version of the session, oldest first. */
export async function listAnalysisVersions(db: Db, sessionId: string): Promise<AnalysisVersion[]> {
  return db.select().from(analysisVersions).where(eq(analysisVersions.sessionId, sessionId)).orderBy(asc(analysisVersions.version));
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
  return v ? loadBundle(db, v) : null;
}

/** One complete version of the session's analysis, current or not (the evaluation script compares versions). */
export async function getAnalysisByVersion(db: Db, sessionId: string, version: number): Promise<AnalysisBundle | null> {
  const [v] = await db
    .select()
    .from(analysisVersions)
    .where(and(eq(analysisVersions.sessionId, sessionId), eq(analysisVersions.version, version), eq(analysisVersions.status, "complete")));
  return v ? loadBundle(db, v) : null;
}

export async function getAnalysisTopics(db: Db, analysisId: string): Promise<Topic[]> {
  return db.select().from(topics).where(eq(topics.analysisId, analysisId)).orderBy(asc(topics.idx));
}

async function loadBundle(db: Db, v: AnalysisVersion): Promise<AnalysisBundle> {
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
    version: { id: v.id, version: v.version, reason: v.reason, status: v.status, createdAt: v.createdAt, profile: v.profile, namesAt: v.namesAt },
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
            findMoreRequestId: r.findMoreRequestId ?? null,
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

export async function getBriefing(db: Db, analysisId: string): Promise<BriefingContent | null> {
  const [row] = await db.select().from(briefings).where(eq(briefings.analysisId, analysisId));
  return row ? { lead: row.lead, sections: row.sections } : null;
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

export type TranslationRow = { status: "pending" | "ready" | "failed"; content: unknown | null; error: string | null };

export async function getTranslation(db: Db, analysisId: string, language: string, kind: "briefing"): Promise<TranslationRow | null> {
  const [row] = await db
    .select({ status: translations.status, content: translations.content, error: translations.error })
    .from(translations)
    .where(and(eq(translations.analysisId, analysisId), eq(translations.language, language), eq(translations.kind, kind)));
  return row ?? null;
}

const translationKey = [translations.analysisId, translations.language, translations.kind];

/** Stores the finished translation (status `ready`, error cleared). */
export async function saveTranslation(db: Db, analysisId: string, language: string, kind: "briefing", content: unknown): Promise<void> {
  await db
    .insert(translations)
    .values({ analysisId, language, kind, content, status: "ready", error: null })
    .onConflictDoUpdate({ target: translationKey, set: { content, status: "ready", error: null, updatedAt: new Date() } });
}

/** Marks the translation `pending` (clearing any error), unless it is already `ready`. */
export async function requestTranslation(db: Db, analysisId: string, language: string, kind: "briefing"): Promise<void> {
  await db
    .insert(translations)
    .values({ analysisId, language, kind, content: null, status: "pending", error: null })
    .onConflictDoUpdate({
      target: translationKey,
      set: { content: null, status: "pending", error: null, updatedAt: new Date() },
      setWhere: ne(translations.status, "ready"),
    });
}

/** Marks a `pending` translation failed with a user-facing message; a ready one is left alone. */
export async function failTranslation(db: Db, analysisId: string, language: string, kind: "briefing", error: string): Promise<void> {
  await db
    .update(translations)
    .set({ status: "failed", error })
    .where(and(eq(translations.analysisId, analysisId), eq(translations.language, language), eq(translations.kind, kind), ne(translations.status, "ready")));
}

/** Removes a translation row (rolls back a request whose job could not be queued), unless it is `ready`. */
export async function deletePendingTranslation(db: Db, analysisId: string, language: string, kind: "briefing"): Promise<void> {
  await db
    .delete(translations)
    .where(and(eq(translations.analysisId, analysisId), eq(translations.language, language), eq(translations.kind, kind), eq(translations.status, "pending")));
}
