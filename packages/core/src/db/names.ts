import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { normaliseName, type Attribution, type AttributionSource, type Person } from "../attribution.ts";
import type { Db } from "./client.ts";
import { attributions, contextCards, persons } from "./schema.ts";

/** What the AI sources may write: never `human`, and never a human-only status shape. */
export type NewAiAttribution = Pick<Attribution, "speakerId" | "startMs" | "endMs" | "personId" | "status" | "confidence" | "evidence">;

const toPerson = (r: typeof persons.$inferSelect): Person => ({
  id: r.id, displayName: r.displayName, fullName: r.fullName, kind: r.kind, party: r.party, state: r.state,
  role: r.role, photoUrl: r.photoUrl, officialIds: r.officialIds,
});

const toAttribution = (r: typeof attributions.$inferSelect): Attribution => ({ ...r });

const nameNorm = (displayName: string, fullName?: string | null) => normaliseName(`${displayName} ${fullName ?? ""}`);

export async function createCustomPerson(db: Db, a: { displayName: string; createdBy: string }): Promise<Person> {
  const [row] = await db
    .insert(persons)
    .values({ displayName: a.displayName, kind: "custom", nameNorm: nameNorm(a.displayName), createdBy: a.createdBy })
    .returning();
  return toPerson(row!);
}

export async function upsertOfficialPerson(
  db: Db,
  p: {
    chamber: "senado" | "camara"; officialId: string; displayName: string;
    fullName?: string | null; party?: string | null; state?: string | null; role?: string | null; photoUrl?: string | null;
  },
): Promise<Person> {
  const fields = {
    displayName: p.displayName, fullName: p.fullName ?? null, party: p.party ?? null, state: p.state ?? null,
    role: p.role ?? null, photoUrl: p.photoUrl ?? null, nameNorm: nameNorm(p.displayName, p.fullName),
  };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`person:${p.chamber}:${p.officialId}`}))`);
    const [existing] = await tx
      .select()
      .from(persons)
      .where(sql`${persons.officialIds}->>${p.chamber} = ${p.officialId}`);
    if (existing) {
      const [row] = await tx.update(persons).set(fields).where(eq(persons.id, existing.id)).returning();
      return toPerson(row!);
    }
    const [row] = await tx
      .insert(persons)
      .values({ ...fields, kind: "official", officialIds: { [p.chamber]: p.officialId }, createdBy: "record" })
      .returning();
    return toPerson(row!);
  });
}

export async function findPersonByName(db: Db, name: string): Promise<Person | null> {
  const n = normaliseName(name);
  if (!n) return null;
  const rows = await db.select().from(persons);
  const hit = rows.find((r) => normaliseName(r.displayName) === n || (r.fullName !== null && normaliseName(r.fullName) === n));
  return hit ? toPerson(hit) : null;
}

export async function searchPersons(db: Db, q: string, limit = 10): Promise<Person[]> {
  const n = normaliseName(q);
  if (!n) return [];
  const esc = n.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .select()
    .from(persons)
    .where(ilike(persons.nameNorm, `%${esc}%`))
    .orderBy(persons.displayName)
    .limit(limit);
  return rows.map(toPerson);
}

export async function getPersons(db: Db, ids: string[]): Promise<Person[]> {
  if (ids.length === 0) return [];
  return (await db.select().from(persons).where(inArray(persons.id, ids))).map(toPerson);
}

export async function listAttributions(db: Db, sessionId: string): Promise<Attribution[]> {
  const rows = await db
    .select()
    .from(attributions)
    .where(and(eq(attributions.sessionId, sessionId), isNull(attributions.supersededAt)))
    .orderBy(attributions.createdAt);
  return rows.map(toAttribution);
}

/** Only writer of `source = 'human'` rows. */
export async function setHumanAttribution(
  db: Db,
  a: { sessionId: string; speakerId: string; startMs: number | null; endMs: number | null; personId: string | null; ownerId: string },
): Promise<Attribution> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${a.sessionId}))`);
    const scope =
      a.startMs === null || a.endMs === null
        ? and(isNull(attributions.startMs), isNull(attributions.endMs))
        : and(eq(attributions.startMs, a.startMs), eq(attributions.endMs, a.endMs));
    await tx
      .update(attributions)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          eq(attributions.sessionId, a.sessionId), eq(attributions.speakerId, a.speakerId),
          eq(attributions.source, "human"), isNull(attributions.supersededAt), scope,
        ),
      );
    const ranged = a.startMs !== null && a.endMs !== null;
    const [row] = await tx
      .insert(attributions)
      .values({
        sessionId: a.sessionId, speakerId: a.speakerId, startMs: ranged ? a.startMs : null, endMs: ranged ? a.endMs : null,
        personId: a.personId, source: "human", status: a.personId ? "confirmed" : "anonymous", confidence: 1,
        evidence: { kind: "none" }, createdBy: a.ownerId,
      })
      .returning();
    return toAttribution(row!);
  });
}

export async function replaceAiAttributions(
  db: Db,
  sessionId: string,
  source: Exclude<AttributionSource, "human">,
  rows: NewAiAttribution[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
    await tx
      .update(attributions)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(attributions.sessionId, sessionId), eq(attributions.source, source), isNull(attributions.supersededAt)));
    if (rows.length === 0) return;
    await tx.insert(attributions).values(rows.map((r) => ({ ...r, sessionId, source, createdBy: source })));
  });
}

/** Every attribution row of a session, superseded ones included (oldest first): the history `namesChangedSince` reads. */
export async function listAttributionHistory(db: Db, sessionId: string): Promise<Attribution[]> {
  const rows = await db.select().from(attributions).where(eq(attributions.sessionId, sessionId)).orderBy(attributions.createdAt);
  return rows.map(toAttribution);
}

/** Sessions with a context card and no attribution row at all (current or superseded); `ids` limits the search. */
export async function sessionsWithoutNames(db: Db, ids?: string[]): Promise<string[]> {
  if (ids && ids.length === 0) return [];
  const rows = await db
    .select({ id: contextCards.sessionId })
    .from(contextCards)
    .where(
      and(
        ids ? inArray(contextCards.sessionId, ids) : undefined,
        sql`not exists (select 1 from ${attributions} where ${attributions.sessionId} = ${contextCards.sessionId})`,
      ),
    )
    .orderBy(contextCards.sessionId);
  return rows.map((r) => r.id);
}

/**
 * Only for the one-off backfill of old sessions (`importNamesForOldSessions`): dates the session's attribution rows
 * to its context card's last update, when those names were written into the card. Otherwise names imported today
 * would look newer than every analysis version and raise a false "Names changed" notice.
 */
export async function backdateNamesToCard(db: Db, sessionId: string): Promise<void> {
  await db.execute(sql`
    update ${attributions} set created_at = ${contextCards.updatedAt}
    from ${contextCards}
    where ${attributions.sessionId} = ${sessionId} and ${contextCards.sessionId} = ${sessionId}
      and ${attributions.source} in ('transcript', 'metadata') and ${attributions.createdBy} = ${attributions.source}`);
}
