import {
  countInOffice, countSpeechesInWindow, replaceSpeechWindow, replaceVotes, rollCallIdsWithBill, setInOffice, upsertMembers, upsertRollCalls, type Db,
} from "@digestor/core/server";
import { mapLimit } from "../records/http.js";
import { fetchBill, fetchInOfficeIds, fetchMembers, fetchSpeeches, fetchYearCsv, MONITOR_FROM } from "./camara.js";
import { parseCsv, toRollCalls, toVotes } from "./rollCalls.js";

/** Nightly refresh of the parliament monitor, after the Câmara regenerates its bulk files (04:00–07:10 UTC). */
export const MONITOR_REFRESH_QUEUE = "monitor.refresh";
export const MONITOR_REFRESH_CRON = "0 9 * * *";
const CONCURRENCY = 4;

export type RefreshCounts = {
  members: number; speeches: { inserted: number; kept: number; failed: number }; rollCalls: number; votes: number; bills: number;
};

/** Days of speeches re-read each night: transcriptions are often published weeks late (42 still empty in dev, some 2 months old). */
export const SPEECH_WINDOW_DAYS = 60;

/**
 * Deputies (everyone who sat since `MONITOR_FROM`, in office today flagged), each deputy's speeches in
 * [speechesFrom, to] (replaced, so late transcriptions arrive), then the year's roll calls and votes from the bulk
 * files, then bills still missing an id or summary. Upserts and window replaces only: a rerun is harmless.
 * The Câmara sometimes answers 200 with an empty list when it is failing: a deputy whose stored speeches in the window
 * would all be deleted by an empty answer is skipped (`kept`) and the run warns once.
 */
export async function refreshMonitor(
  deps: { db: Db; fetch: typeof fetch }, a: { speechesFrom: string; to: string; year: number },
): Promise<RefreshCounts> {
  const { db, fetch: f } = deps;
  const members = await fetchMembers(f, MONITOR_FROM, a.to);
  const ids = await upsertMembers(db, members);
  // The same 200-with-an-empty-list failure would mark every deputy "Not in office now": an empty or much shorter list
  // than the one stored keeps the stored flags.
  const inOffice = await fetchInOfficeIds(f);
  const before = await countInOffice(db, "camara");
  if (inOffice.length === 0 || inOffice.length < before / 2) {
    console.warn(`monitor.refresh: the Câmara listed ${inOffice.length} deputies in office (${before} stored); kept the stored in-office flags`);
  } else {
    await setInOffice(db, "camara", inOffice);
  }

  // One deputy failing (5xx twice, a malformed record) is counted and skipped: the rest and the votes still refresh.
  // Only a mostly failed run throws, so pg-boss retries it.
  let inserted = 0;
  let kept = 0;
  let failed = 0;
  let lastError: unknown = null;
  await mapLimit([...ids], CONCURRENCY, async ([externalId, memberId]) => {
    try {
      const rows = await fetchSpeeches(f, externalId, a.speechesFrom, a.to);
      if (rows.length === 0 && (await countSpeechesInWindow(db, memberId, a.speechesFrom, a.to)) > 0) {
        kept++;
        return;
      }
      const r = await replaceSpeechWindow(db, memberId, a.speechesFrom, a.to, rows);
      inserted += r.inserted; // after the await: `x += await …` reads x before it and loses parallel updates
    } catch (err) {
      failed++;
      lastError = err;
    }
  });
  if (kept > 0) console.warn(`monitor.refresh: the Câmara sent no speeches for ${kept} deputies who have some stored in the window; kept them`);
  if (failed > 0) console.warn(`monitor.refresh: speeches of ${failed} deputies failed; last error:`, lastError instanceof Error ? lastError.message : lastError);
  if (failed > ids.size / 2) throw new Error(`monitor.refresh: speeches failed for ${failed} of ${ids.size} deputies`);
  const speeches = { inserted, kept, failed };

  // One file at a time: three large parallel downloads are what the Câmara cut off. A file that doesn't exist (a 4xx,
  // e.g. the new year's on 1 January) is final: no roll calls this run, no retry.
  let votacoes, objetos, votos;
  try {
    votacoes = parseCsv(await fetchYearCsv(f, "votacoes", a.year));
    objetos = parseCsv(await fetchYearCsv(f, "votacoesObjetos", a.year));
    votos = parseCsv(await fetchYearCsv(f, "votacoesVotos", a.year));
  } catch (err) {
    if (!(err as { final?: boolean }).final) throw err;
    console.warn(`monitor.refresh: no roll calls for ${a.year}:`, (err as Error).message);
    return { members: members.length, speeches, rollCalls: 0, votes: 0, bills: 0 };
  }
  const rollCalls = toRollCalls(votacoes, objetos);
  await upsertRollCalls(db, rollCalls.map(({ needsBill: _, ...r }) => r));

  const votesByRollCall = toVotes(votos);
  const voters = new Map<number, { name: string; party: string; uf: string }>();
  for (const list of votesByRollCall.values()) for (const v of list) voters.set(v.externalId, v);
  const missing = [...voters].filter(([id]) => !ids.has(id));
  const added = await upsertMembers(
    db, missing.map(([externalId, v]) => ({ house: "camara", externalId, name: v.name, party: v.party || null, uf: v.uf || null, photoUrl: null })),
  );
  const memberIdOf = new Map([...ids, ...added]);
  let votes = 0;
  for (const rc of rollCalls) {
    const rows = (votesByRollCall.get(rc.id) ?? []).map((v) => ({ memberId: memberIdOf.get(v.externalId)!, vote: v.vote }));
    await replaceVotes(db, rc.id, rows);
    votes += rows.length;
  }

  const known = await rollCallIdsWithBill(db, rollCalls.map((r) => r.id));
  const toFetch = rollCalls.filter((r) => r.needsBill && !known.has(r.id));
  const found = await mapLimit(toFetch, CONCURRENCY, (r) =>
    fetchBill(f, r.needsBill!).catch((err) => {
      console.warn(`monitor.refresh: bill of roll call ${r.id} not fetched:`, err instanceof Error ? err.message : err);
      return null; // tried again next night
    }),
  );
  const bills = toFetch.flatMap((r, i) => {
    const b = found[i];
    return b ? [{ ...r, billId: b.id, billLabel: b.label, billSummary: b.summary }] : [];
  });
  await upsertRollCalls(db, bills.map(({ needsBill: _, ...r }) => r));

  return { members: members.length, speeches, rollCalls: rollCalls.length, votes, bills: bills.length };
}

/** The nightly window: the last `SPEECH_WINDOW_DAYS` of speeches (late transcriptions), this year's roll calls. */
export function nightlyWindow(now = new Date()): { speechesFrom: string; to: string; year: number } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { speechesFrom: day(new Date(now.getTime() - SPEECH_WINDOW_DAYS * 86_400_000)), to: day(now), year: now.getUTCFullYear() };
}
