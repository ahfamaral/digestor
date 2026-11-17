import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { parlSessionVideos, parlSpeeches, parlSpeechVideos } from "./schema.ts";

// Parliament monitor: where each speech is in its session's official video (YouTube), matched against the video's
// automatic captions by the worker's `monitor.video` job. Only pointers are stored, never the video or the captions.

export type SessionVideoStatus = "pending" | "running" | "done" | "no_video" | "no_captions" | "failed";
export type SessionVideoClaim = { sessionId: number; startsAt: string; attempts: number };
export type SpeechVideoInput = { speechKey: string; startS: number; endS: number; score: number };
export type SpeechVideo = { videoId: string; startS: number; endS: number };

/** A `running` row untouched this long belongs to a job that died; the next claim takes it over. */
const STALE_RUNNING_MIN = 30;

/**
 * Adds a `pending` row for every held session (status "Encerrada…") that has none, and sends a `done` session back to
 * `pending` when more of its speeches have text now than at its last run (transcriptions arrive weeks late), or when a
 * speech moment it stored points at a key no speech has any more (the nightly refresh stored a revised text, so the
 * speech got a new key; the rematch replaces the session's moments). Returns both counts.
 */
export async function queueSessionVideos(db: Db): Promise<{ added: number; requeued: number }> {
  const added = await db.execute(sql`
    insert into parl_session_videos (session_id)
    select id from parl_sessions where status like 'Encerrada%'
    on conflict (session_id) do nothing`);
  const requeued = await db.execute(sql`
    update parl_session_videos v set status = 'pending', retry_at = null, updated_at = now()
    where v.status = 'done' and (
      (v.stream_start is not null and v.duration_s is not null and (
        select count(*) from parl_speeches s
        where s.text <> '' and s.starts_at between v.stream_start - interval '45 minutes'
          and v.stream_start + make_interval(secs => v.duration_s) + interval '10 minutes'
      ) > v.spoken)
      or exists (
        select 1 from parl_speech_videos sv
        where sv.session_id = v.session_id
          and not exists (select 1 from parl_speeches s where s.speech_key = sv.speech_key)
      ))`);
  return { added: added.rowCount ?? 0, requeued: requeued.rowCount ?? 0 };
}

/**
 * Compare-and-set claim of one session to match: `pending` first (newest session first), then rows whose `retry_at`
 * is due, then `running` rows untouched for 30 minutes. The row becomes `running` with one more attempt.
 */
export async function claimSessionVideo(db: Db, now = new Date()): Promise<SessionVideoClaim | null> {
  const stale = new Date(now.getTime() - STALE_RUNNING_MIN * 60_000);
  const r = await db.execute<{ session_id: number; attempts: number; starts_at: string }>(sql`
    with pick as (
      select v.session_id from parl_session_videos v join parl_sessions p on p.id = v.session_id
      where v.status = 'pending'
         or (v.status in ('done', 'no_video', 'no_captions', 'failed') and v.retry_at is not null and v.retry_at <= ${now.toISOString()})
         or (v.status = 'running' and v.updated_at < ${stale.toISOString()})
      order by (v.status = 'pending') desc, p.starts_at desc
      limit 1
      for update of v skip locked
    )
    update parl_session_videos v set status = 'running', attempts = v.attempts + 1, updated_at = now()
    from pick, parl_sessions p
    where v.session_id = pick.session_id and p.id = v.session_id
    returning v.session_id, v.attempts, p.starts_at::text as starts_at`);
  const row = r.rows[0];
  return row ? { sessionId: row.session_id, attempts: row.attempts, startsAt: row.starts_at } : null;
}

export type SessionVideoResult = {
  status: Exclude<SessionVideoStatus, "pending" | "running">;
  videoId?: string | null;
  streamStart?: string | null;
  durationS?: number | null;
  spoken?: number;
  matched?: number;
  error?: string | null;
  retryAt?: Date | null;
};

/** Records a claimed session's outcome; only a row still `running` is written (a stale job that lost it writes nothing). */
export async function finishSessionVideo(db: Db, sessionId: number, r: SessionVideoResult): Promise<boolean> {
  const rows = await db
    .update(parlSessionVideos)
    .set({
      status: r.status,
      ...(r.videoId !== undefined ? { videoId: r.videoId } : {}),
      ...(r.streamStart !== undefined ? { streamStart: r.streamStart } : {}),
      ...(r.durationS !== undefined ? { durationS: r.durationS } : {}),
      ...(r.spoken !== undefined ? { spoken: r.spoken } : {}),
      ...(r.matched !== undefined ? { matched: r.matched } : {}),
      error: r.error ?? null,
      retryAt: r.retryAt ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(parlSessionVideos.sessionId, sessionId), eq(parlSessionVideos.status, "running")))
    .returning({ id: parlSessionVideos.sessionId });
  return rows.length > 0;
}

/** Speeches with text whose stamp is in [from, to] (Brasília local timestamps), oldest first. */
export async function speechesInRange(db: Db, from: string, to: string): Promise<{ speechKey: string; startsAt: string; text: string }[]> {
  const rows = await db
    .select({ speechKey: parlSpeeches.speechKey, startsAt: parlSpeeches.startsAt, text: parlSpeeches.text })
    .from(parlSpeeches)
    .where(and(ne(parlSpeeches.text, ""), gte(parlSpeeches.startsAt, from), lte(parlSpeeches.startsAt, to)))
    .orderBy(parlSpeeches.startsAt, parlSpeeches.id);
  return rows.flatMap((r) => (r.speechKey ? [{ speechKey: r.speechKey, startsAt: r.startsAt, text: r.text }] : []));
}

/**
 * One transaction: the session's speech moments become `rows`. A speech already placed in another session's video
 * (two sessions' ranges overlap) keeps the better score.
 */
export async function replaceSessionSpeechVideos(db: Db, sessionId: number, videoId: string, rows: SpeechVideoInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(parlSpeechVideos).where(eq(parlSpeechVideos.sessionId, sessionId));
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(parlSpeechVideos)
        .values(rows.slice(i, i + 500).map((r) => ({ ...r, sessionId, videoId })))
        .onConflictDoUpdate({
          target: parlSpeechVideos.speechKey,
          set: {
            sessionId: sql`excluded.session_id`, videoId: sql`excluded.video_id`, startS: sql`excluded.start_s`, endS: sql`excluded.end_s`,
            score: sql`excluded.score`, alignedAt: sql`now()`,
          },
          setWhere: sql`excluded.score > ${parlSpeechVideos.score}`,
        });
    }
  });
}

/** What clipping one speech needs: its video moment, the plenary (Câmara event id), the video's length and who spoke when. */
export type SpeechClipSource = SpeechVideo & {
  /** The plenary's Câmara event id (`parl_sessions.id`). */
  eventId: number;
  /** The video's length in seconds, when the matching run stored it. */
  durationS: number | null;
  name: string;
  /** Party and state on the day, else today's. */
  party: string | null;
  uf: string | null;
  /** Brasília local "YYYY-MM-DDTHH:MM". */
  startsAt: string;
};

/** The video moment of one speech and who gave it, or null when the speech has none. */
export async function speechClipSource(db: Db, speechKey: string): Promise<SpeechClipSource | null> {
  const r = await db.execute<{
    video_id: string; start_s: number; end_s: number; event_id: number; duration_s: number | null; name: string;
    party: string | null; uf: string | null; starts_at: string;
  }>(sql`
    select v.video_id, v.start_s, v.end_s, v.session_id as event_id, sv.duration_s, m.name,
      case when s.party is not null then s.party else m.party end as party,
      case when s.party is not null then s.uf else m.uf end as uf,
      to_char(s.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at
    from parl_speech_videos v
    join parl_speeches s on s.speech_key = v.speech_key
    join parl_members m on m.id = s.member_id
    left join parl_session_videos sv on sv.session_id = v.session_id
    where v.speech_key = ${speechKey}
    limit 1`);
  const x = r.rows[0];
  if (!x) return null;
  return {
    videoId: x.video_id, startS: x.start_s, endS: x.end_s, eventId: x.event_id, durationS: x.duration_s, name: x.name,
    party: x.party, uf: x.uf, startsAt: x.starts_at,
  };
}
