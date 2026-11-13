import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { misfiledCopies } from "../monitorText.ts";
import { inOfficeSpans, type ExternalMandate, type HistoryRow, type Position } from "../monitorTimeline.ts";
import type { Db } from "./client.ts";
import { tsQuery, type House } from "./monitor.ts";
import {
  parlBillAuthors, parlBills, parlMemberHistory, parlMembers, parlOrientations, parlPresence, parlRollCalls, parlSessions, parlSpeeches, parlVotes,
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

/**
 * Deletes the copies of speeches the Câmara filed under the wrong deputy (`misfiledCopies`): copies are speeches with the
 * same text at the same minute under different deputies. Run after `fillSpeechParties` (it compares the party on the
 * day). Returns the rows deleted.
 */
export async function dropMisfiledSpeeches(db: Db): Promise<number> {
  const r = await db.execute<{ id: number; name: string; party: string | null; uf: string | null; text: string; grp: string }>(sql`
    with dup as (
      select starts_at, md5(text) as h from parl_speeches where text <> '' group by 1, 2 having count(distinct member_id) > 1
    )
    select s.id, m.name, s.party, s.uf, s.text, s.starts_at::text || ':' || dup.h as grp
    from parl_speeches s join dup on dup.starts_at = s.starts_at and dup.h = md5(s.text) join parl_members m on m.id = s.member_id
    order by s.id`);
  const groups = new Map<string, typeof r.rows>();
  for (const row of r.rows) groups.set(row.grp, [...(groups.get(row.grp) ?? []), row]);
  const ids = [...groups.values()].flatMap((g) => misfiledCopies(g[0]!.text, g));
  for (const part of chunks(ids)) await db.delete(parlSpeeches).where(inArray(parlSpeeches.id, part));
  return ids.length;
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

/** Stored history rows of a member (the refresh keeps them when the Câmara answers empty). */
export async function countHistory(db: Db, memberId: number): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from parl_member_history where member_id = ${memberId}`);
  return r.rows[0]?.n ?? 0;
}

/** Stored presence, authorship and guidance rows (the refresh keeps them when a bulk file comes back empty or short). */
export async function monitorRowCounts(db: Db): Promise<{ presence: number; billAuthors: number; orientations: number }> {
  const r = await db.execute<{ presence: number; bill_authors: number; orientations: number }>(sql`
    select (select count(*)::int from parl_presence) as presence, (select count(*)::int from parl_bill_authors) as bill_authors,
      (select count(*)::int from parl_orientations) as orientations`);
  const x = r.rows[0];
  return { presence: x?.presence ?? 0, billAuthors: x?.bill_authors ?? 0, orientations: x?.orientations ?? 0 };
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

export async function getProfile(db: Db, memberId: number): Promise<ProfileInput & { refreshedAt: string | null }> {
  const [r] = await db
    .select({
      profession: parlMembers.profession, externalMandates: parlMembers.externalMandates, fronts: parlMembers.fronts,
      positions: parlMembers.positions, refreshedAt: parlMembers.profileRefreshedAt,
    })
    .from(parlMembers)
    .where(eq(parlMembers.id, memberId));
  return {
    profession: r?.profession ?? null, externalMandates: r?.externalMandates ?? [], fronts: r?.fronts ?? [], positions: r?.positions ?? [],
    refreshedAt: r?.refreshedAt ? r.refreshedAt.toISOString() : null,
  };
}

export type Presence = { sessions: number; present: number; missing: { id: number; startsAt: string; description: string }[] };

/**
 * The deputy's presence record for `year`: closed plenary deliberative sessions held while they were in office (from
 * the history, to the minute), and those with no presence recorded. A session nobody's presence was recorded for
 * (joint Congress veto sessions, typed "Sessão Deliberativa" too) isn't counted: the file doesn't cover it. Null
 * without history (the in-office periods are unknown).
 */
export async function getPresence(db: Db, memberId: number, year: number): Promise<Presence | null> {
  const history = await getHistory(db, memberId);
  if (history.length === 0) return null;
  const periods = inOfficeSpans(history);
  const rows = await db.execute<{ id: number; starts_at: string; description: string; present: boolean }>(sql`
    select s.id, to_char(s.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at, s.description,
      exists (select 1 from parl_presence p where p.session_id = s.id and p.member_id = ${memberId}) as present
    from parl_sessions s
    where s.status = 'Encerrada' and s.starts_at >= make_date(${year}, 1, 1) and s.starts_at < make_date(${year} + 1, 1, 1)
      and exists (select 1 from parl_presence any_p where any_p.session_id = s.id)
    order by s.starts_at, s.id`);
  const held = rows.rows.filter((s) => periods.some((p) => s.starts_at >= p.from && (p.to === null || s.starts_at < p.to)));
  return {
    sessions: held.length,
    present: held.filter((s) => s.present).length,
    missing: held.filter((s) => !s.present).map((s) => ({ id: s.id, startsAt: s.starts_at, description: s.description })),
  };
}

export type MemberBill = { id: number; type: string; number: number; year: number; summary: string; presentedAt: string; firstAuthor: boolean };

/**
 * Bills and requests the deputy signed, newest first. `q`: search terms (OR-ed, as the speech search) over the summary;
 * `year`: the year presented. `byType` counts the bills matching `q` and `year` (the type filter aside), most first;
 * `all` counts every bill the deputy signed; `years`: the years presented, newest first.
 */
export async function listMemberBills(
  db: Db, memberId: number, a: { type?: string; q?: string[]; year?: number; limit?: number; offset?: number },
): Promise<{ total: number; all: number; years: number[]; byType: { type: string; n: number }[]; rows: MemberBill[] }> {
  const terms = a.q === undefined ? null : tsQuery(a.q);
  const where: SQL[] = [];
  if (a.q !== undefined) {
    where.push(terms ? sql`and to_tsvector('pt_unaccent', b.summary) @@ (${terms}) and numnode(${terms}) > 0` : sql`and false`);
  }
  if (a.year !== undefined) where.push(sql`and extract(year from b.presented_at) = ${a.year}`);
  const filters = sql.join(where, sql` `);
  const [by, years] = await Promise.all([
    db.execute<{ type: string; n: number }>(sql`
      select b.type, count(*)::int as n from parl_bill_authors a join parl_bills b on b.id = a.bill_id
      where a.member_id = ${memberId} ${filters} group by b.type order by n desc, b.type`),
    db.execute<{ y: number; n: number }>(sql`
      select extract(year from b.presented_at)::int as y, count(*)::int as n from parl_bill_authors a join parl_bills b on b.id = a.bill_id
      where a.member_id = ${memberId} group by 1 order by 1 desc`),
  ]);
  const typeWhere = a.type ? sql`and b.type = ${a.type}` : sql``;
  const total = a.type ? (by.rows.find((r) => r.type === a.type)?.n ?? 0) : by.rows.reduce((s, r) => s + r.n, 0);
  const rows = total === 0 ? { rows: [] } : await db.execute<{ id: number; type: string; number: number; year: number; summary: string; presented_at: string; first_author: boolean }>(sql`
    select b.id, b.type, b.number, b.year, b.summary, to_char(b.presented_at, 'YYYY-MM-DD"T"HH24:MI') as presented_at, a.first_author
    from parl_bill_authors a join parl_bills b on b.id = a.bill_id
    where a.member_id = ${memberId} ${typeWhere} ${filters}
    order by b.presented_at desc, b.id desc limit ${a.limit ?? 20} offset ${a.offset ?? 0}`);
  return {
    total,
    all: years.rows.reduce((s, r) => s + r.n, 0),
    years: years.rows.map((r) => r.y),
    byType: by.rows,
    rows: rows.rows.map((r) => ({
      id: r.id, type: r.type, number: r.number, year: r.year, summary: r.summary, presentedAt: r.presented_at, firstAuthor: r.first_author,
    })),
  };
}

export type RollCallDetail = {
  id: string; date: string; description: string; yes: number; no: number; other: number; billId: number | null; billLabel: string | null;
  billSummary: string;
  parties: { party: string | null; counts: { vote: string; n: number }[]; deputies: { externalId: number; name: string; uf: string | null; vote: string }[] }[];
  orientations: { bloc: string; orientation: string }[];
};

/** Labels in the order the Câmara lists them; anything else follows, as published. */
const VOTE_ORDER = ["Sim", "Não", "Abstenção", "Obstrução", "Artigo 17"];
const byName = (a: string, b: string) => a.localeCompare(b, "pt-BR");

/** Just the roll call's bill label (a page title), or null when the roll call is unknown. */
export async function getRollCallTitle(db: Db, id: string): Promise<{ billLabel: string | null } | null> {
  const [r] = await db.select({ billLabel: parlRollCalls.billLabel }).from(parlRollCalls).where(eq(parlRollCalls.id, id));
  return r ?? null;
}

/** A roll call with its votes grouped by the party at the time of the vote, and the guidance as published. */
export async function getRollCall(db: Db, id: string): Promise<RollCallDetail | null> {
  const [rc] = await db.select().from(parlRollCalls).where(eq(parlRollCalls.id, id));
  if (!rc) return null;
  const votes = await db
    .select({
      externalId: parlMembers.externalId, name: parlMembers.name, vote: parlVotes.vote,
      party: sql<string | null>`coalesce(${parlVotes.party}, ${parlMembers.party})`, uf: sql<string | null>`coalesce(${parlVotes.uf}, ${parlMembers.uf})`,
    })
    .from(parlVotes)
    .innerJoin(parlMembers, eq(parlMembers.id, parlVotes.memberId))
    .where(eq(parlVotes.rollCallId, id));
  const groups = new Map<string | null, RollCallDetail["parties"][number]["deputies"]>();
  for (const v of votes) {
    const list = groups.get(v.party || null) ?? [];
    list.push({ externalId: v.externalId, name: v.name, uf: v.uf, vote: v.vote });
    groups.set(v.party || null, list);
  }
  const rank = (vote: string) => (VOTE_ORDER.includes(vote) ? VOTE_ORDER.indexOf(vote) : VOTE_ORDER.length);
  const parties = [...groups]
    .map(([party, deputies]) => {
      const counts = new Map<string, number>();
      for (const d of deputies) counts.set(d.vote, (counts.get(d.vote) ?? 0) + 1);
      return {
        party,
        counts: [...counts].map(([vote, n]) => ({ vote, n })).sort((a, b) => rank(a.vote) - rank(b.vote) || byName(a.vote, b.vote)),
        deputies: deputies.sort((a, b) => byName(a.name, b.name)),
      };
    })
    .sort((a, b) => b.deputies.length - a.deputies.length || byName(a.party ?? "￿", b.party ?? "￿"));
  const orientations = (
    await db.select({ bloc: parlOrientations.bloc, orientation: parlOrientations.orientation }).from(parlOrientations).where(eq(parlOrientations.rollCallId, id))
  ).sort((a, b) => byName(a.bloc, b.bloc));
  return {
    id: rc.id, date: rc.date, description: rc.description, yes: rc.yes, no: rc.no, other: rc.other, billId: rc.billId, billLabel: rc.billLabel,
    billSummary: rc.billSummary, parties, orientations,
  };
}
