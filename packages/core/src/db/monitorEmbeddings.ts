import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.ts";
import { parlRecordEmbeddings, parlSpeechEmbeddings } from "./schema.ts";

// Bookkeeping of the monitor's meaning index (`parl_speech_embeddings`); the vectors themselves live in Chroma.

export type SpeechText = { speechKey: string; text: string; summary: string };
/** `memberId`: `parl_members.id`; `startsAt`: Brasília local time, "YYYY-MM-DDTHH:MM". */
export type SpeechToEmbed = SpeechText & { memberId: number; startsAt: string };

/** Speeches with text (or a summary) whose key is not in the index yet, newest first. */
export async function speechesToEmbed(db: Db, limit: number): Promise<SpeechToEmbed[]> {
  const r = await db.execute<{ speech_key: string; text: string; summary: string; member_id: number; starts_at: string }>(sql`
    select s.speech_key, s.text, s.summary, s.member_id, to_char(s.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at from parl_speeches s
    where s.speech_key is not null and (s.text <> '' or s.summary <> '')
      and not exists (select 1 from parl_speech_embeddings e where e.speech_key = s.speech_key)
    order by s.starts_at desc, s.id desc
    limit ${limit}`);
  return r.rows.map((x) => ({ speechKey: x.speech_key, text: x.text, summary: x.summary, memberId: x.member_id, startsAt: x.starts_at }));
}

/** Keys in the index that no speech has any more (a revised text gets a new key; a speech the Câmara withdrew). */
export async function orphanEmbeddings(db: Db): Promise<string[]> {
  const r = await db.execute<{ speech_key: string }>(sql`
    select e.speech_key from parl_speech_embeddings e
    where not exists (select 1 from parl_speeches s where s.speech_key = e.speech_key)
    order by e.speech_key`);
  return r.rows.map((x) => x.speech_key);
}

export async function markEmbedded(db: Db, rows: { speechKey: string; chunks: number }[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(parlSpeechEmbeddings)
    .values(rows)
    .onConflictDoUpdate({
      target: parlSpeechEmbeddings.speechKey,
      set: { chunks: sql`excluded.chunks`, embeddedAt: sql`now()` },
    });
}

export async function forgetEmbeddings(db: Db, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(parlSpeechEmbeddings).where(inArray(parlSpeechEmbeddings.speechKey, keys));
}

/** The text and summary of these speeches (unknown keys skipped), for passages scored on the fly. */
export async function speechTextsByKeys(db: Db, keys: string[]): Promise<SpeechText[]> {
  if (keys.length === 0) return [];
  const r = await db.execute<{ speech_key: string; text: string; summary: string }>(sql`
    select speech_key, text, summary from parl_speeches
    where speech_key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`);
  const byKey = new Map(r.rows.map((x) => [x.speech_key, { speechKey: x.speech_key, text: x.text, summary: x.summary }]));
  return keys.flatMap((k) => byKey.get(k) ?? []);
}

// ── Roll calls and bills (`parl_record_embeddings`) ──────────────────────────────────────────────────────────────────

export type RecordKind = "roll_call" | "bill";
/** `hash`: md5 of `text`, stored when embedded; `date`: "YYYY-MM-DD" (the vote, or the bill's presentation). */
export type RecordToEmbed = { id: string; text: string; hash: string; date: string };

/**
 * Each record's embedded text, built in SQL so its md5 is computed in one place. A roll call: its bill label, the
 * bill's summary and what was voted ("PL 1/2026 — Dispõe sobre… — Aprovado o projeto."). A bill: its label and summary,
 * only for bills a member signed (the deputy page lists no others) that have a summary.
 */
function recordTexts(kind: RecordKind): SQL {
  return kind === "roll_call"
    ? sql`select r.id, concat_ws(' — ', nullif(r.bill_label, ''), nullif(r.bill_summary, ''), r.description) as text,
        to_char(r.date, 'YYYY-MM-DD') as date, r.date as at from parl_roll_calls r`
    : sql`select b.id::text as id, b.type || ' ' || b.number || '/' || b.year || ' — ' || b.summary as text,
        to_char(b.presented_at, 'YYYY-MM-DD') as date, b.presented_at as at from parl_bills b
        where b.summary <> '' and exists (select 1 from parl_bill_authors a where a.bill_id = b.id)`;
}

/** Records not in the index yet, or whose text changed since they were embedded, newest first. */
export async function recordsToEmbed(db: Db, kind: RecordKind, limit: number): Promise<RecordToEmbed[]> {
  const r = await db.execute<{ id: string; text: string; hash: string; date: string }>(sql`
    select t.id, t.text, md5(t.text) as hash, t.date from (${recordTexts(kind)}) t
    where not exists (select 1 from parl_record_embeddings e where e.kind = ${kind} and e.id = t.id and e.hash = md5(t.text))
    order by t.at desc, t.id desc
    limit ${limit}`);
  return r.rows.map((x) => ({ id: x.id, text: x.text, hash: x.hash, date: x.date }));
}

/** Ids in the index that no record has any more (deleted, or a bill whose summary or authors are gone). */
export async function orphanRecordEmbeddings(db: Db, kind: RecordKind): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    select e.id from parl_record_embeddings e
    where e.kind = ${kind} and not exists (select 1 from (${recordTexts(kind)}) t where t.id = e.id)
    order by e.id`);
  return r.rows.map((x) => x.id);
}

export async function markRecordsEmbedded(db: Db, kind: RecordKind, rows: { id: string; hash: string }[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(parlRecordEmbeddings)
    .values(rows.map((r) => ({ kind, id: r.id, hash: r.hash })))
    .onConflictDoUpdate({
      target: [parlRecordEmbeddings.kind, parlRecordEmbeddings.id],
      set: { hash: sql`excluded.hash`, embeddedAt: sql`now()` },
    });
}

export async function forgetRecordEmbeddings(db: Db, kind: RecordKind, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(parlRecordEmbeddings).where(and(eq(parlRecordEmbeddings.kind, kind), inArray(parlRecordEmbeddings.id, ids)));
}
