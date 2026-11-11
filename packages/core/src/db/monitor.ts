import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { HIGHLIGHT_END, HIGHLIGHT_START, normName } from "../monitorText.ts";
import type { Db } from "./client.ts";
import { parlMembers, parlRollCalls, parlSpeeches, parlVotes } from "./schema.ts";

// Parliament monitor (Câmara preview): official records only, stored as published.

export type House = "camara";
export type MemberInput = { house: House; externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null };
/** `startsAt` is Brasília local time as published, "YYYY-MM-DDTHH:MM". */
export type SpeechInput = { startsAt: string; phase: string | null; kind: string | null; summary: string; text: string; keywords: string };
export type RollCallInput = {
  id: string; date: string; registeredAt: string | null; description: string; yes: number; no: number; other: number;
  billId: number | null; billLabel: string | null; billSummary: string;
};

export type MemberRow = {
  id: number; externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null; inOffice: boolean;
};
export type SpeechRow = { id: number; startsAt: string; phase: string | null; kind: string | null; summary: string; text: string };
export type SpeechHit = SpeechRow & { member: Pick<MemberRow, "externalId" | "name" | "party" | "uf">; snippet: string };
export type RollCallHit = {
  id: string; date: string; description: string; yes: number; no: number; other: number; billId: number | null;
  billLabel: string | null; snippet: string;
};
export type VoteRow = {
  rollCallId: string; date: string; description: string; billId: number | null; billLabel: string | null; billSummary: string; vote: string;
};

const HEADLINE = `StartSel=${HIGHLIGHT_START},StopSel=${HIGHLIGHT_END},MaxFragments=2,MaxWords=30,MinWords=10`;
const CHUNK = 500;

/** "2026-11-09 10:00:00" or "2026-11-09T10:00" → "2026-11-09T10:00". */
const localMinute = (s: string) => s.replace(" ", "T").slice(0, 16);
/** Window bounds: `from` inclusive, `to` inclusive (a whole day). */
const windowWhere = (memberId: number, from: string, to: string) =>
  and(
    eq(parlSpeeches.memberId, memberId),
    gte(parlSpeeches.startsAt, `${from} 00:00:00`),
    lt(parlSpeeches.startsAt, sql`(${to}::date + 1)::timestamp`),
  );

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** The terms OR-ed into one tsquery; null when no term has a searchable word (stop words, punctuation). */
function tsQuery(terms: string[]): SQL | null {
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  return sql.join(
    clean.map((t) => sql`websearch_to_tsquery('pt_unaccent', ${t})`),
    sql` || `,
  );
}

const toMember = (r: typeof parlMembers.$inferSelect): MemberRow => ({
  id: r.id, externalId: r.externalId, name: r.name, party: r.party, uf: r.uf, photoUrl: r.photoUrl, inOffice: r.inOffice,
});

// ── Members ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert or update by (house, externalId). A missing photo/party/uf never wipes a known one. Returns externalId → id. */
export async function upsertMembers(db: Db, rows: MemberInput[]): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  for (const part of chunks(rows)) {
    const out = await db
      .insert(parlMembers)
      .values(part.map((r) => ({ ...r, nameNorm: normName(r.name) })))
      .onConflictDoUpdate({
        target: [parlMembers.house, parlMembers.externalId],
        set: {
          name: sql`excluded.name`,
          nameNorm: sql`excluded.name_norm`,
          party: sql`coalesce(excluded.party, ${parlMembers.party})`,
          uf: sql`coalesce(excluded.uf, ${parlMembers.uf})`,
          photoUrl: sql`coalesce(excluded.photo_url, ${parlMembers.photoUrl})`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: parlMembers.id, externalId: parlMembers.externalId });
    for (const r of out) ids.set(r.externalId, r.id);
  }
  return ids;
}

/** In office: true for these external ids, false for the rest of the house. */
export async function setInOffice(db: Db, house: House, externalIds: number[]): Promise<void> {
  const list = externalIds.length > 0 ? sql`${parlMembers.externalId} = any(${sql.param(externalIds)}::int[])` : sql`false`;
  await db.update(parlMembers).set({ inOffice: sql`${list}` }).where(eq(parlMembers.house, house));
}

export async function getMember(db: Db, house: House, externalId: number): Promise<MemberRow | null> {
  const [r] = await db.select().from(parlMembers).where(and(eq(parlMembers.house, house), eq(parlMembers.externalId, externalId)));
  return r ? toMember(r) : null;
}

/** Name search, accent- and case-insensitive, partial names; closest names first. */
export async function searchMembers(db: Db, q: string, limit = 8): Promise<MemberRow[]> {
  const n = normName(q);
  if (!n) return [];
  const esc = n.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .select()
    .from(parlMembers)
    .where(sql`${parlMembers.nameNorm} ilike ${`%${esc}%`}`)
    .orderBy(sql`similarity(${parlMembers.nameNorm}, ${n}) desc`, parlMembers.name)
    .limit(limit);
  return rows.map(toMember);
}

// ── Speeches ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One transaction: delete the member's speeches in [from, to] (days, inclusive) and insert `rows`. */
export async function replaceSpeechWindow(
  db: Db, memberId: number, from: string, to: string, rows: SpeechInput[],
): Promise<{ deleted: number; inserted: number }> {
  return db.transaction(async (tx) => {
    const del = await tx.delete(parlSpeeches).where(windowWhere(memberId, from, to)).returning({ id: parlSpeeches.id });
    for (const part of chunks(rows)) {
      await tx.insert(parlSpeeches).values(part.map((r) => ({ ...r, memberId, startsAt: `${localMinute(r.startsAt)}:00` })));
    }
    return { deleted: del.length, inserted: rows.length };
  });
}

export async function countSpeechesInWindow(db: Db, memberId: number, from: string, to: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(parlSpeeches).where(windowWhere(memberId, from, to));
  return r?.n ?? 0;
}

export async function listMemberSpeeches(
  db: Db, memberId: number, a: { limit?: number; offset?: number },
): Promise<{ total: number; rows: SpeechRow[] }> {
  const [c] = await db.select({ n: count() }).from(parlSpeeches).where(eq(parlSpeeches.memberId, memberId));
  const rows = await db
    .select({
      id: parlSpeeches.id, startsAt: parlSpeeches.startsAt, phase: parlSpeeches.phase, kind: parlSpeeches.kind,
      summary: parlSpeeches.summary, text: parlSpeeches.text,
    })
    .from(parlSpeeches)
    .where(eq(parlSpeeches.memberId, memberId))
    .orderBy(desc(parlSpeeches.startsAt), desc(parlSpeeches.id))
    .limit(a.limit ?? 50)
    .offset(a.offset ?? 0);
  return { total: c?.n ?? 0, rows: rows.map((r) => ({ ...r, startsAt: localMinute(r.startsAt) })) };
}

type SpeechHitSql = {
  id: number; starts_at: string; phase: string | null; kind: string | null; summary: string; text: string; external_id: number;
  name: string; party: string | null; uf: string | null; snippet: string;
};

/** Full-text search over speeches (any of the terms), best match first, then newest; snippets for the page's rows only. */
export async function searchSpeeches(
  db: Db, a: { terms: string[]; memberId?: number; limit?: number; offset?: number },
): Promise<{ total: number; rows: SpeechHit[] }> {
  const q = tsQuery(a.terms);
  if (!q) return { total: 0, rows: [] };
  const member = a.memberId === undefined ? sql`` : sql`and s.member_id = ${a.memberId}`;
  const hits = sql`select s.*, ts_rank_cd(s.tsv, q.q) as rank from parl_speeches s, q where numnode(q.q) > 0 and s.tsv @@ q.q ${member}`;
  const c = await db.execute<{ n: number }>(sql`with q as (select (${q}) as q) select count(*)::int as n from (${hits}) h`);
  const total = c.rows[0]?.n ?? 0;
  if (total === 0) return { total: 0, rows: [] };
  const r = await db.execute<SpeechHitSql>(sql`
    with q as (select (${q}) as q)
    select p.id, to_char(p.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at, p.phase, p.kind, p.summary, p.text,
      m.external_id, m.name, m.party, m.uf,
      ts_headline('pt_unaccent', concat_ws(' … ', nullif(p.summary, ''), nullif(p.text, '')), q.q, ${HEADLINE}) as snippet
    from (${hits} order by rank desc, s.starts_at desc, s.id desc limit ${a.limit ?? 20} offset ${a.offset ?? 0}) p
    join parl_members m on m.id = p.member_id, q
    order by p.rank desc, p.starts_at desc, p.id desc`);
  return {
    total,
    rows: r.rows.map((x) => ({
      id: x.id, startsAt: x.starts_at, phase: x.phase, kind: x.kind, summary: x.summary, text: x.text,
      member: { externalId: x.external_id, name: x.name, party: x.party, uf: x.uf }, snippet: x.snippet,
    })),
  };
}

// ── Roll calls and votes ───────────────────────────────────────────────────────────────────────────────────────────

/** Insert or update by id. A bill already found (id, label, summary) is kept when the new row has none. */
export async function upsertRollCalls(db: Db, rows: RollCallInput[]): Promise<void> {
  for (const part of chunks(rows)) {
    await db
      .insert(parlRollCalls)
      .values(part.map((r) => ({ ...r, house: "camara" as const })))
      .onConflictDoUpdate({
        target: parlRollCalls.id,
        set: {
          date: sql`excluded.date`,
          registeredAt: sql`excluded.registered_at`,
          description: sql`excluded.description`,
          yes: sql`excluded.yes`,
          no: sql`excluded.no`,
          other: sql`excluded.other`,
          billId: sql`coalesce(excluded.bill_id, ${parlRollCalls.billId})`,
          billLabel: sql`coalesce(excluded.bill_label, ${parlRollCalls.billLabel})`,
          billSummary: sql`case when excluded.bill_summary <> '' then excluded.bill_summary else ${parlRollCalls.billSummary} end`,
        },
      });
  }
}

/** Of these roll calls, the ones whose bill id is already known. */
export async function rollCallIdsWithBill(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: parlRollCalls.id })
    .from(parlRollCalls)
    .where(and(inArray(parlRollCalls.id, ids), isNotNull(parlRollCalls.billId)));
  return new Set(rows.map((r) => r.id));
}

/** One transaction: the roll call's votes become exactly `rows`. */
export async function replaceVotes(db: Db, rollCallId: string, rows: { memberId: number; vote: string }[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(parlVotes).where(eq(parlVotes.rollCallId, rollCallId));
    for (const part of chunks(rows)) await tx.insert(parlVotes).values(part.map((r) => ({ ...r, rollCallId })));
  });
}

type RollCallHitSql = {
  id: string; date: string; description: string; yes: number; no: number; other: number; bill_id: number | null;
  bill_label: string | null; snippet: string;
};

/** Full-text search over roll calls (bill summary + what was voted); never any deputy's vote. */
export async function searchRollCalls(db: Db, a: { terms: string[]; limit?: number }): Promise<RollCallHit[]> {
  const q = tsQuery(a.terms);
  if (!q) return [];
  const r = await db.execute<RollCallHitSql>(sql`
    with q as (select (${q}) as q)
    select p.id, to_char(p.date, 'YYYY-MM-DD') as date, p.description, p.yes, p.no, p.other, p.bill_id, p.bill_label,
      ts_headline('pt_unaccent', concat_ws(' … ', nullif(p.bill_summary, ''), p.description), q.q, ${HEADLINE}) as snippet
    from (
      select r.*, ts_rank_cd(r.tsv, q.q) as rank from parl_roll_calls r, q
      where numnode(q.q) > 0 and r.tsv @@ q.q and r.yes + r.no + r.other > 0
      order by rank desc, r.date desc, r.id limit ${a.limit ?? 10}
    ) p, q
    order by p.rank desc, p.date desc, p.id`);
  return r.rows.map((x) => ({
    id: x.id, date: x.date, description: x.description, yes: x.yes, no: x.no, other: x.other, billId: x.bill_id,
    billLabel: x.bill_label, snippet: x.snippet,
  }));
}

/** The member's recorded votes, newest roll call first. */
export async function listMemberVotes(
  db: Db, memberId: number, a: { limit?: number; offset?: number },
): Promise<{ total: number; rows: VoteRow[] }> {
  const [c] = await db.select({ n: count() }).from(parlVotes).where(eq(parlVotes.memberId, memberId));
  const rows = await db
    .select({
      rollCallId: parlVotes.rollCallId, date: parlRollCalls.date, description: parlRollCalls.description, billId: parlRollCalls.billId,
      billLabel: parlRollCalls.billLabel, billSummary: parlRollCalls.billSummary, vote: parlVotes.vote,
    })
    .from(parlVotes)
    .innerJoin(parlRollCalls, eq(parlRollCalls.id, parlVotes.rollCallId))
    .where(eq(parlVotes.memberId, memberId))
    .orderBy(desc(parlRollCalls.date), sql`${parlRollCalls.registeredAt} desc nulls last`, desc(parlRollCalls.id))
    .limit(a.limit ?? 100)
    .offset(a.offset ?? 0);
  return { total: c?.n ?? 0, rows };
}
