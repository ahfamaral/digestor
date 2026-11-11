import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ExternalMandate, HistoryRow, Position } from "../monitorTimeline.ts";
import type { Db } from "./client.ts";
import type { House } from "./monitor.ts";
import {
  parlBillAuthors, parlBills, parlMemberHistory, parlMembers, parlOrientations, parlPresence, parlSessions,
} from "./schema.ts";

// Parliament monitor: the deputy's record beyond speeches and votes (history, profile, authored bills, presence) and
// the roll calls' guidance. Stored as published.

export type HistoryInput = HistoryRow;
export type ProfileInput = { profession: string | null; externalMandates: ExternalMandate[]; fronts: string[]; positions: Position[] };
export type BillInput = { id: number; type: string; number: number; year: number; summary: string; presentedAt: string };
export type SessionInput = { id: number; startsAt: string; description: string; status: string };

const CHUNK = 500;
function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
/** "2026-11-09 10:00:00" or "2026-11-09T10:00" → "2026-11-09T10:00". */
const localMinute = (s: string) => s.replace(" ", "T").slice(0, 16);

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One transaction: the member's history becomes exactly `rows`. */
export async function replaceHistory(db: Db, memberId: number, rows: HistoryInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(parlMemberHistory).where(eq(parlMemberHistory.memberId, memberId));
    for (const part of chunks(rows)) {
      await tx.insert(parlMemberHistory).values(part.map((r) => ({ ...r, memberId, at: `${localMinute(r.at)}:00` })));
    }
  });
}

export async function setProfile(db: Db, memberId: number, p: ProfileInput): Promise<void> {
  await db
    .update(parlMembers)
    .set({ profession: p.profession, externalMandates: p.externalMandates, fronts: p.fronts, positions: p.positions, profileRefreshedAt: sql`now()` })
    .where(eq(parlMembers.id, memberId));
}

/** Members whose profile is to be fetched: all of the house, or only those never fetched. */
export async function membersNeedingProfile(db: Db, house: House, all: boolean): Promise<{ id: number; externalId: number }[]> {
  return db
    .select({ id: parlMembers.id, externalId: parlMembers.externalId })
    .from(parlMembers)
    .where(and(eq(parlMembers.house, house), all ? undefined : isNull(parlMembers.profileRefreshedAt)))
    .orderBy(asc(parlMembers.id));
}

/**
 * Each speech's party and state on the day: the member's last history row at or before the speech. Speeches of
 * members without history keep null. Returns the rows updated.
 */
export async function fillSpeechParties(db: Db): Promise<number> {
  const r = await db.execute(sql`
    update parl_speeches s set party = x.party, uf = x.uf
    from (
      select p.id, h.party, h.uf from parl_speeches p
      cross join lateral (
        select party, uf from parl_member_history h where h.member_id = p.member_id and h.at <= p.starts_at order by h.at desc, h.id desc limit 1
      ) h
    ) x
    where x.id = s.id and (s.party is distinct from x.party or s.uf is distinct from x.uf)`);
  return r.rowCount ?? 0;
}

export async function upsertBills(db: Db, rows: BillInput[]): Promise<void> {
  for (const part of chunks(rows)) {
    await db
      .insert(parlBills)
      .values(part.map((r) => ({ ...r, house: "camara" as const, presentedAt: `${localMinute(r.presentedAt)}:00` })))
      .onConflictDoUpdate({
        target: parlBills.id,
        set: {
          type: sql`excluded.type`, number: sql`excluded.number`, year: sql`excluded.year`, summary: sql`excluded.summary`,
          presentedAt: sql`excluded.presented_at`,
        },
      });
  }
}

/** One transaction: the authors of `billIds` become exactly `rows`. */
export async function replaceBillAuthors(
  db: Db, billIds: number[], rows: { billId: number; memberId: number; firstAuthor: boolean }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const part of chunks(billIds)) await tx.delete(parlBillAuthors).where(inArray(parlBillAuthors.billId, part));
    for (const part of chunks(rows)) await tx.insert(parlBillAuthors).values(part).onConflictDoNothing();
  });
}

export async function replaceOrientations(db: Db, rollCallId: string, rows: { bloc: string; orientation: string }[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(parlOrientations).where(eq(parlOrientations.rollCallId, rollCallId));
    if (rows.length > 0) await tx.insert(parlOrientations).values(rows.map((r) => ({ ...r, rollCallId }))).onConflictDoNothing();
  });
}

export async function upsertSessions(db: Db, rows: SessionInput[]): Promise<void> {
  for (const part of chunks(rows)) {
    await db
      .insert(parlSessions)
      .values(part.map((r) => ({ ...r, house: "camara" as const, startsAt: `${localMinute(r.startsAt)}:00` })))
      .onConflictDoUpdate({
        target: parlSessions.id,
        set: { startsAt: sql`excluded.starts_at`, description: sql`excluded.description`, status: sql`excluded.status` },
      });
  }
}

/** One transaction: the presence at `sessionIds` becomes exactly `rows`. */
export async function replacePresence(db: Db, sessionIds: number[], rows: { sessionId: number; memberId: number }[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const part of chunks(sessionIds)) await tx.delete(parlPresence).where(inArray(parlPresence.sessionId, part));
    for (const part of chunks(rows)) await tx.insert(parlPresence).values(part).onConflictDoNothing();
  });
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The member's history, oldest first. */
export async function getHistory(db: Db, memberId: number): Promise<HistoryRow[]> {
  const rows = await db
    .select({ at: parlMemberHistory.at, party: parlMemberHistory.party, uf: parlMemberHistory.uf, status: parlMemberHistory.status, description: parlMemberHistory.description })
    .from(parlMemberHistory)
    .where(eq(parlMemberHistory.memberId, memberId))
    .orderBy(asc(parlMemberHistory.at), asc(parlMemberHistory.id));
  return rows.map((r) => ({ ...r, at: localMinute(r.at) }));
}
