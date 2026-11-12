import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { HIGHLIGHT_END, HIGHLIGHT_START, normName } from "../monitorText.ts";
import type { Db } from "./client.ts";
import type { SpeechVideo } from "./monitorVideo.ts";
import { parlMembers, parlRollCalls, parlSpeeches, parlSpeechVideos, parlVotes } from "./schema.ts";

// Parliament monitor (Câmara preview): official records only, stored as published.

export type House = "camara";
export type MemberInput = { house: House; externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null };
/** `startsAt` is Brasília local time as published, "YYYY-MM-DDTHH:MM". */
export type SpeechInput = {
  startsAt: string; phase: string | null; kind: string | null; summary: string; text: string; keywords: string;
  /** The Câmara's page for the text (`urlText`); `textFile`: published as an attached file, `text` is its heading only. */
  urlText?: string | null; textFile?: boolean;
};
export type RollCallInput = {
  id: string; date: string; registeredAt: string | null; description: string; yes: number; no: number; other: number;
  billId: number | null; billLabel: string | null; billSummary: string;
};

export type MemberRow = {
  id: number; externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null; inOffice: boolean;
};
export type SpeechRow = {
  id: number; startsAt: string; phase: string | null; kind: string | null; summary: string; text: string;
  urlText: string | null; textFile: boolean;
  /** Where the speech is in the session's official video (`parl_speech_videos`), or null. */
  video: SpeechVideo | null;
};
/** `member` carries today's party and state; `partyThen`/`ufThen` are the speaker's on the day (null without history). */
export type SpeechHit = SpeechRow & {
  member: Pick<MemberRow, "externalId" | "name" | "party" | "uf">; snippet: string; partyThen: string | null; ufThen: string | null;
};
/** Days inclusive; `party`/`uf` are the speaker's on the day; `inOffice` = in office today. */
export type SpeechFilters = { from?: string; to?: string; party?: string; uf?: string; phase?: string; inOffice?: boolean };
export type SortOrder = "best" | "new";
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

/**
 * Rank: full-text rank, plus 1 when the row holds `phrase` (the words as typed, together) so those come first under
 * "Best match". Normalization 32 (rank / (rank + 1)) keeps the order and stays below 1, so the +1 always wins; a raw
 * `ts_rank_cd` goes far above 1 on long speeches (24 for "saúde"). phraseto_tsquery never reads its input as syntax.
 */
function rankSql(alias: "s" | "r", phrase: string | undefined): SQL {
  const col = sql.raw(`${alias}.tsv`);
  const base = sql`ts_rank_cd(${col}, q.q, 32)`;
  const p = phrase?.trim();
  return p ? sql`${base} + case when ${col} @@ phraseto_tsquery('pt_unaccent', ${p}) then 1 else 0 end` : base;
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

export async function countInOffice(db: Db, house: House): Promise<number> {
  const [r] = await db.select({ n: count() }).from(parlMembers).where(and(eq(parlMembers.house, house), eq(parlMembers.inOffice, true)));
  return r?.n ?? 0;
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
    // The name starting with the text first, then a word starting with it ("Melo" for "mel"), then the text inside a
    // word ("Vermelho"); similarity and the name break ties.
    .orderBy(
      sql`case when ${parlMembers.nameNorm} ilike ${`${esc}%`} then 0 when ${parlMembers.nameNorm} ilike ${`% ${esc}%`} then 1 else 2 end`,
      sql`similarity(${parlMembers.nameNorm}, ${n}) desc`,
      parlMembers.name,
    )
    .limit(limit);
  return rows.map(toMember);
}

/**
 * Every deputy of the house in alphabetical order (accents and case ignored), for the directory page: a few hundred
 * rows, filtered and grouped by letter in the web app. Alphabetical only, never ranked.
 */
export async function listMembers(db: Db, house: House): Promise<MemberRow[]> {
  const rows = await db.select().from(parlMembers).where(eq(parlMembers.house, house)).orderBy(parlMembers.nameNorm, parlMembers.name, parlMembers.externalId);
  return rows.map(toMember);
}

// ── Speeches ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A speech's stable key: deputy, start minute and a fingerprint of its text (summary when there is no text yet), so the
 * nightly window replace gives the same speech the same key. It changes once if the transcription arrives late.
 */
export function speechKey(externalId: number, startsAt: string, text: string): string {
  return `${externalId}:${startsAt}:${createHash("sha1").update(normName(text)).digest("hex").slice(0, 10)}`;
}

/**
 * One transaction: delete the member's speeches in [from, to] (days, inclusive) and insert `rows`, each with its
 * `speechKey` (the n-th identical speech in one call gets ":n").
 */
export async function replaceSpeechWindow(
  db: Db, memberId: number, from: string, to: string, rows: SpeechInput[],
): Promise<{ deleted: number; inserted: number }> {
  return db.transaction(async (tx) => {
    const [m] = await tx.select({ externalId: parlMembers.externalId }).from(parlMembers).where(eq(parlMembers.id, memberId));
    const del = await tx.delete(parlSpeeches).where(windowWhere(memberId, from, to)).returning({ id: parlSpeeches.id });
    const seen = new Map<string, number>();
    const keyed = rows.map((r) => {
      const base = speechKey(m?.externalId ?? memberId, localMinute(r.startsAt), r.text || r.summary);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { ...r, memberId, startsAt: `${localMinute(r.startsAt)}:00`, speechKey: n === 1 ? base : `${base}:${n}` };
    });
    for (const part of chunks(keyed)) await tx.insert(parlSpeeches).values(part);
    return { deleted: del.length, inserted: rows.length };
  });
}

export async function countSpeechesInWindow(db: Db, memberId: number, from: string, to: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(parlSpeeches).where(windowWhere(memberId, from, to));
  return r?.n ?? 0;
}

export async function listMemberSpeeches(
  db: Db, memberId: number, a: { limit?: number; offset?: number; from?: string; to?: string; phase?: string },
): Promise<{ total: number; rows: SpeechRow[] }> {
  const where = and(
    eq(parlSpeeches.memberId, memberId),
    a.from ? gte(parlSpeeches.startsAt, `${a.from} 00:00:00`) : undefined,
    a.to ? lt(parlSpeeches.startsAt, sql`(${a.to}::date + 1)::timestamp`) : undefined,
    a.phase ? eq(parlSpeeches.phase, a.phase) : undefined,
  );
  const [c] = await db.select({ n: count() }).from(parlSpeeches).where(where);
  const rows = await db
    .select({
      id: parlSpeeches.id, startsAt: parlSpeeches.startsAt, phase: parlSpeeches.phase, kind: parlSpeeches.kind,
      summary: parlSpeeches.summary, text: parlSpeeches.text, urlText: parlSpeeches.urlText, textFile: parlSpeeches.textFile,
      videoId: parlSpeechVideos.videoId, startS: parlSpeechVideos.startS, endS: parlSpeechVideos.endS,
    })
    .from(parlSpeeches)
    .leftJoin(parlSpeechVideos, eq(parlSpeechVideos.speechKey, parlSpeeches.speechKey))
    .where(where)
    .orderBy(desc(parlSpeeches.startsAt), desc(parlSpeeches.id))
    .limit(a.limit ?? 50)
    .offset(a.offset ?? 0);
  return {
    total: c?.n ?? 0,
    rows: rows.map(({ videoId, startS, endS, ...r }) => ({
      ...r, startsAt: localMinute(r.startsAt), video: videoId !== null && startS !== null && endS !== null ? { videoId, startS, endS } : null,
    })),
  };
}

/** The filters as `and …` conditions on speeches aliased `s`. */
function speechFilterSql(f: SpeechFilters = {}): SQL {
  const parts: SQL[] = [];
  if (f.from) parts.push(sql`and s.starts_at >= ${f.from}::date`);
  if (f.to) parts.push(sql`and s.starts_at < (${f.to}::date + 1)`);
  if (f.party) parts.push(sql`and s.party = ${f.party}`);
  if (f.uf) parts.push(sql`and s.uf = ${f.uf}`);
  if (f.phase) parts.push(sql`and s.phase = ${f.phase}`);
  if (f.inOffice) parts.push(sql`and exists (select 1 from parl_members im where im.id = s.member_id and im.in_office)`);
  return sql.join(parts, sql` `);
}

type SpeechHitSql = {
  id: number; starts_at: string; phase: string | null; kind: string | null; summary: string; text: string; external_id: number;
  url_text: string | null; text_file: boolean; video_id: string | null; start_s: number | null; end_s: number | null;
  name: string; party: string | null; uf: string | null; party_then: string | null; uf_then: string | null; snippet: string;
};

/**
 * Full-text search over speeches (any of the terms), best match first (then newest) or newest first; snippets for the
 * page's rows only. `mentionOf`: other deputies' speeches that name this one (a phrase match on the name), the terms
 * then optional; the name is highlighted in the snippet too.
 */
export async function searchSpeeches(
  db: Db,
  a: {
    terms: string[]; memberId?: number; mentionOf?: { memberId: number; name: string }; filters?: SpeechFilters; sort?: SortOrder;
    limit?: number; offset?: number; phrase?: string;
  },
): Promise<{ total: number; rows: SpeechHit[] }> {
  const topic = tsQuery(a.terms);
  // phraseto_tsquery, not websearch_to_tsquery: a name must never be read as search syntax ("-", "or", quotes).
  const name = a.mentionOf ? sql`phraseto_tsquery('pt_unaccent', ${a.mentionOf.name})` : null;
  if (!topic && !name) return { total: 0, rows: [] };
  const match = name && topic ? sql`(${name}) && (${topic})` : (name ?? topic)!;
  const head = name && topic ? sql`(${name}) || (${topic})` : match;
  const member = a.memberId === undefined ? sql`` : sql`and s.member_id = ${a.memberId}`;
  const notSelf = a.mentionOf ? sql`and s.member_id <> ${a.mentionOf.memberId}` : sql``;
  const hits = sql`select s.*, ${rankSql("s", a.phrase)} as rank from parl_speeches s, q
    where numnode(q.q) > 0 and s.tsv @@ q.q ${member} ${notSelf} ${speechFilterSql(a.filters)}`;
  const inner = a.sort === "new" ? sql`s.starts_at desc, s.id desc` : sql`rank desc, s.starts_at desc, s.id desc`;
  const outer = a.sort === "new" ? sql`p.starts_at desc, p.id desc` : sql`p.rank desc, p.starts_at desc, p.id desc`;
  const c = await db.execute<{ n: number }>(sql`with q as (select (${match}) as q) select count(*)::int as n from (${hits}) h`);
  const total = c.rows[0]?.n ?? 0;
  if (total === 0) return { total: 0, rows: [] };
  const r = await db.execute<SpeechHitSql>(sql`
    with q as (select (${match}) as q, (${head}) as hq)
    select p.id, to_char(p.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at, p.phase, p.kind, p.summary, p.text,
      p.url_text, p.text_file, p.party as party_then, p.uf as uf_then, m.external_id, m.name, m.party, m.uf,
      v.video_id, v.start_s, v.end_s,
      ts_headline('pt_unaccent', concat_ws(' … ', nullif(p.summary, ''), nullif(p.text, '')), q.hq, ${HEADLINE}) as snippet
    from (${hits} order by ${inner} limit ${a.limit ?? 20} offset ${a.offset ?? 0}) p
    join parl_members m on m.id = p.member_id
    left join parl_speech_videos v on v.speech_key = p.speech_key, q
    order by ${outer}`);
  return {
    total,
    rows: r.rows.map((x) => ({
      id: x.id, startsAt: x.starts_at, phase: x.phase, kind: x.kind, summary: x.summary, text: x.text,
      urlText: x.url_text, textFile: x.text_file, member: { externalId: x.external_id, name: x.name, party: x.party, uf: x.uf }, snippet: x.snippet,
      partyThen: x.party_then, ufThen: x.uf_then,
      video: x.video_id !== null && x.start_s !== null && x.end_s !== null ? { videoId: x.video_id, startS: x.start_s, endS: x.end_s } : null,
    })),
  };
}

/** The values the landing filters offer: speakers' parties and states on the day, session phases; alphabetical. */
export async function speechFacets(db: Db): Promise<{ parties: string[]; ufs: string[]; phases: string[] }> {
  const col = async (c: "party" | "uf" | "phase") => {
    const r = await db.execute<{ v: string }>(sql`select distinct ${sql.raw(c)} as v from parl_speeches where ${sql.raw(c)} is not null and ${sql.raw(c)} <> ''`);
    return r.rows.map((x) => x.v).sort((a, b) => a.localeCompare(b, "pt-BR"));
  };
  const [parties, ufs, phases] = await Promise.all([col("party"), col("uf"), col("phase")]);
  return { parties, ufs, phases };
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
export async function replaceVotes(
  db: Db, rollCallId: string, rows: { memberId: number; vote: string; party?: string | null; uf?: string | null }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(parlVotes).where(eq(parlVotes.rollCallId, rollCallId));
    for (const part of chunks(rows)) await tx.insert(parlVotes).values(part.map((r) => ({ ...r, rollCallId })));
  });
}

type RollCallHitSql = {
  id: string; date: string; description: string; yes: number; no: number; other: number; bill_id: number | null;
  bill_label: string | null; snippet: string;
};

/** Full-text search over roll calls (bill summary + what was voted), paged; never any deputy's vote. Days inclusive. */
export async function searchRollCalls(
  db: Db, a: { terms: string[]; from?: string; to?: string; sort?: SortOrder; limit?: number; offset?: number; phrase?: string },
): Promise<{ total: number; rows: RollCallHit[] }> {
  const q = tsQuery(a.terms);
  if (!q) return { total: 0, rows: [] };
  const dates = sql.join(
    [a.from ? sql`and r.date >= ${a.from}::date` : sql``, a.to ? sql`and r.date <= ${a.to}::date` : sql``],
    sql` `,
  );
  const hits = sql`select r.*, ${rankSql("r", a.phrase)} as rank from parl_roll_calls r, q
    where numnode(q.q) > 0 and r.tsv @@ q.q and r.yes + r.no + r.other > 0 ${dates}`;
  const c = await db.execute<{ n: number }>(sql`with q as (select (${q}) as q) select count(*)::int as n from (${hits}) h`);
  const total = c.rows[0]?.n ?? 0;
  if (total === 0) return { total: 0, rows: [] };
  const inner = a.sort === "new" ? sql`r.date desc, r.id desc` : sql`rank desc, r.date desc, r.id`;
  const outer = a.sort === "new" ? sql`p.date desc, p.id desc` : sql`p.rank desc, p.date desc, p.id`;
  const r = await db.execute<RollCallHitSql>(sql`
    with q as (select (${q}) as q)
    select p.id, to_char(p.date, 'YYYY-MM-DD') as date, p.description, p.yes, p.no, p.other, p.bill_id, p.bill_label,
      ts_headline('pt_unaccent', concat_ws(' … ', nullif(p.bill_summary, ''), p.description), q.q, ${HEADLINE}) as snippet
    from (${hits} order by ${inner} limit ${a.limit ?? 10} offset ${a.offset ?? 0}) p, q
    order by ${outer}`);
  return {
    total,
    rows: r.rows.map((x) => ({
      id: x.id, date: x.date, description: x.description, yes: x.yes, no: x.no, other: x.other, billId: x.bill_id,
      billLabel: x.bill_label, snippet: x.snippet,
    })),
  };
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
