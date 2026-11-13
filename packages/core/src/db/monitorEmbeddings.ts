import { inArray, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { parlSpeechEmbeddings } from "./schema.ts";

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
