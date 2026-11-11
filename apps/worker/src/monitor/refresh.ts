import {
  countSpeechesInWindow, replaceSpeechWindow, replaceVotes, rollCallIdsWithBill, setInOffice, upsertMembers, upsertRollCalls, type Db,
} from "@digestor/core/server";
import { mapLimit } from "../records/http.js";
import { fetchBill, fetchInOfficeIds, fetchMembers, fetchSpeeches, fetchYearCsv, MONITOR_FROM } from "./camara.js";
import { parseCsv, toRollCalls, toVotes } from "./rollCalls.js";

/** Nightly refresh of the parliament monitor, after the Câmara regenerates its bulk files (04:00–07:10 UTC). */
export const MONITOR_REFRESH_QUEUE = "monitor.refresh";
export const MONITOR_REFRESH_CRON = "0 9 * * *";
const CONCURRENCY = 4;

export type RefreshCounts = {
  members: number; speeches: { inserted: number; kept: number }; rollCalls: number; votes: number; bills: number;
};

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
  await setInOffice(db, "camara", await fetchInOfficeIds(f));

  let inserted = 0;
  let kept = 0;
  await mapLimit([...ids], CONCURRENCY, async ([externalId, memberId]) => {
    const rows = await fetchSpeeches(f, externalId, a.speechesFrom, a.to);
    if (rows.length === 0 && (await countSpeechesInWindow(db, memberId, a.speechesFrom, a.to)) > 0) {
      kept++;
      return;
    }
    const r = await replaceSpeechWindow(db, memberId, a.speechesFrom, a.to, rows);
    inserted += r.inserted; // after the await: `x += await …` reads x before it and loses parallel updates
  });
  if (kept > 0) console.warn(`monitor.refresh: the Câmara sent no speeches for ${kept} deputies who have some stored in the window; kept them`);

  // One file at a time: three large parallel downloads are what the Câmara cut off.
  const votacoes = parseCsv(await fetchYearCsv(f, "votacoes", a.year));
  const objetos = parseCsv(await fetchYearCsv(f, "votacoesObjetos", a.year));
  const votos = parseCsv(await fetchYearCsv(f, "votacoesVotos", a.year));
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
  const found = await mapLimit(toFetch, CONCURRENCY, (r) => fetchBill(f, r.needsBill!));
  const bills = toFetch.flatMap((r, i) => {
    const b = found[i];
    return b ? [{ ...r, billId: b.id, billLabel: b.label, billSummary: b.summary }] : [];
  });
  await upsertRollCalls(db, bills.map(({ needsBill: _, ...r }) => r));

  return { members: members.length, speeches: { inserted, kept }, rollCalls: rollCalls.length, votes, bills: bills.length };
}

/** The nightly window: the last 7 days of speeches (late transcriptions), this year's roll calls. */
export function nightlyWindow(now = new Date()): { speechesFrom: string; to: string; year: number } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { speechesFrom: day(new Date(now.getTime() - 7 * 86_400_000)), to: day(now), year: now.getUTCFullYear() };
}
