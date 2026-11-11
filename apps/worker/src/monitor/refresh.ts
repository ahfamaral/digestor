import {
  countHistory, countInOffice, countSpeechesInWindow, fillSpeechParties, getProfile, monitorRowCounts, membersNeedingProfile, replaceBillAuthors, replaceHistory, replaceOrientations,
  replacePresence, replaceSpeechWindow, replaceVotes, rollCallIdsWithBill, setInOffice, setProfile, upsertBills, upsertMembers,
  upsertRollCalls, upsertSessions, type Db,
} from "@digestor/core/server";
import { mapLimit } from "../records/http.js";
import {
  fetchBill, fetchHistory, fetchInOfficeIds, fetchMembers, fetchProfile, fetchSpeeches, fetchYearCsv, MONITOR_FROM, type YearCsv,
} from "./camara.js";
import {
  AUTHOR_COLUMNS, BILL_COLUMNS, parseCsv, toBillAuthors, toBills, toOrientations, toPresence, toSessions, type CsvRow,
} from "./bulk.js";
import { toRollCalls, toVotes } from "./rollCalls.js";

/** Nightly refresh of the parliament monitor, after the Câmara regenerates its bulk files (04:00–07:10 UTC). */
export const MONITOR_REFRESH_QUEUE = "monitor.refresh";
export const MONITOR_REFRESH_CRON = "0 9 * * *";
const CONCURRENCY = 4;

export type RefreshCounts = {
  members: number; speeches: { inserted: number; kept: number; failed: number }; rollCalls: number; votes: number; bills: number;
  history: { ok: number; failed: number; kept: number }; profiles: { ok: number; failed: number; kept: number };
  orientations: number; sessions: number; presence: number; authoredBills: number;
};
export type RefreshWindow = { speechesFrom: string; to: string; year: number; profiles: "all" | "missing" };

/** Days of speeches re-read each night: transcriptions are often published weeks late (42 still empty in dev, some 2 months old). */
export const SPEECH_WINDOW_DAYS = 60;

/**
 * Deputies (everyone who sat since `MONITOR_FROM`, in office today flagged), each deputy's history (party changes,
 * leave), each deputy's speeches in [speechesFrom, to] (replaced, so late transcriptions arrive) with the party on the
 * day, profiles (all on Mondays, else only those never fetched), then the year's bulk files one at a time: roll calls
 * and votes, bills still missing an id or summary, guidance, plenary sessions and presence, bills and their authors.
 * Upserts and replaces only: a rerun is harmless.
 * The Câmara sometimes answers 200 with an empty list when it is failing: a deputy whose stored speeches in the window
 * would all be deleted by an empty answer is skipped (`kept`) and the run warns once.
 */
export async function refreshMonitor(
  deps: { db: Db; fetch: typeof fetch }, a: RefreshWindow,
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

  // History before speeches: the party on the day of each speech comes from it. One deputy failing is counted and
  // skipped; only a mostly failed run throws, so pg-boss retries it.
  // An empty answer for a deputy with stored history is the Câmara failing, not a deputy without history: kept.
  const history = { ok: 0, failed: 0, kept: 0 };
  let historyError: unknown = null;
  await mapLimit([...ids], CONCURRENCY, async ([externalId, memberId]) => {
    try {
      const rows = await fetchHistory(f, externalId);
      if (rows.length === 0 && (await countHistory(db, memberId)) > 0) {
        history.kept++;
        return;
      }
      await replaceHistory(db, memberId, rows);
      history.ok++;
    } catch (err) {
      history.failed++;
      historyError = err;
    }
  });
  if (history.kept > 0) console.warn(`monitor.refresh: the Câmara sent no history for ${history.kept} deputies who have some stored; kept it`);
  if (history.failed > 0) {
    console.warn(`monitor.refresh: history of ${history.failed} deputies failed; last error:`, historyError instanceof Error ? historyError.message : historyError);
  }
  if (history.failed > ids.size / 2) throw new Error(`monitor.refresh: history failed for ${history.failed} of ${ids.size} deputies`);

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
  await fillSpeechParties(db);

  // Profiles change rarely: all of them on Mondays, otherwise only deputies never fetched. Failures never throw. An
  // all-empty answer over a stored profile is kept (and not marked refreshed, so a "missing" night asks again).
  const profiles = { ok: 0, failed: 0, kept: 0 };
  let profileError: unknown = null;
  await mapLimit(await membersNeedingProfile(db, "camara", a.profiles === "all"), CONCURRENCY, async (m) => {
    try {
      const p = await fetchProfile(f, m.externalId);
      const empty = (x: typeof p) => !x.profession && x.externalMandates.length + x.fronts.length + x.positions.length === 0;
      if (empty(p) && !empty(await getProfile(db, m.id))) {
        profiles.kept++;
        return;
      }
      await setProfile(db, m.id, p);
      profiles.ok++;
    } catch (err) {
      profiles.failed++;
      profileError = err;
    }
  });
  if (profiles.kept > 0) console.warn(`monitor.refresh: the Câmara sent an empty profile for ${profiles.kept} deputies with one stored; kept it`);
  if (profiles.failed > 0) {
    console.warn(`monitor.refresh: profiles of ${profiles.failed} deputies failed; last error:`, profileError instanceof Error ? profileError.message : profileError);
  }
  const counts = { members: members.length, speeches, history, profiles, rollCalls: 0, votes: 0, bills: 0, orientations: 0, sessions: 0, presence: 0, authoredBills: 0 };

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
    return counts;
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
    const rows = (votesByRollCall.get(rc.id) ?? []).map((v) => ({
      memberId: memberIdOf.get(v.externalId)!, vote: v.vote, party: v.party || null, uf: v.uf || null,
    }));
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
  Object.assign(counts, { rollCalls: rollCalls.length, votes, bills: bills.length });

  // The five files below are each optional: one that doesn't exist (a final 4xx) skips its own part only.
  const optional = async (kind: YearCsv, keep?: string[]): Promise<CsvRow[] | null> => {
    try {
      return parseCsv(await fetchYearCsv(f, kind, a.year), keep);
    } catch (err) {
      if (!(err as { final?: boolean }).final) throw err;
      console.warn(`monitor.refresh: skipped ${kind}-${a.year}:`, (err as Error).message);
      return null;
    }
  };

  // A file that comes back empty or much shorter than what is stored is the Câmara failing (the same 200-with-nothing
  // as the API): its part keeps the stored rows.
  const stored = await monitorRowCounts(db);
  const tooShort = (what: string, n: number, before: number) => {
    if (before === 0 || n >= before / 2) return false;
    console.warn(`monitor.refresh: ${what}: the file gave ${n} rows (${before} stored); kept the stored rows`);
    return true;
  };

  const guidance = await optional("votacoesOrientacoes");
  const byRollCall = guidance ? toOrientations(guidance, new Set(rollCalls.map((r) => r.id))) : null;
  const guidanceRows = byRollCall ? [...byRollCall.values()].reduce((n, l) => n + l.length, 0) : 0;
  if (byRollCall && !tooShort("guidance", guidanceRows, stored.orientations)) {
    for (const rc of rollCalls) {
      const rows = byRollCall.get(rc.id) ?? [];
      await replaceOrientations(db, rc.id, rows);
      counts.orientations += rows.length;
    }
  }

  // Presence and authorship of deputies outside the members list are skipped, never added as members.
  const events = await optional("eventos");
  if (events) {
    const sessions = toSessions(events);
    await upsertSessions(db, sessions);
    counts.sessions = sessions.length;
    const presenceRows = await optional("eventosPresencaDeputados", ["idEvento", "idDeputado"]);
    if (presenceRows) {
      const sessionIds = sessions.map((s) => s.id);
      const rows = toPresence(presenceRows, new Set(sessionIds)).flatMap((p) => {
        const memberId = memberIdOf.get(p.externalId);
        return memberId === undefined ? [] : [{ sessionId: p.sessionId, memberId }];
      });
      if (!tooShort("presence", rows.length, stored.presence)) {
        await replacePresence(db, sessionIds, rows);
        counts.presence = rows.length;
      }
    }
  }

  const billRows = await optional("proposicoes", BILL_COLUMNS);
  if (billRows) {
    const billsOfYear = toBills(billRows);
    await upsertBills(db, billsOfYear);
    const authorRows = await optional("proposicoesAutores", AUTHOR_COLUMNS);
    if (authorRows) {
      const billIds = billsOfYear.map((b) => b.id);
      const rows = toBillAuthors(authorRows, new Set(billIds)).flatMap((r) => {
        const memberId = memberIdOf.get(r.externalId);
        return memberId === undefined ? [] : [{ billId: r.billId, memberId, firstAuthor: r.firstAuthor }];
      });
      if (!tooShort("bill authors", rows.length, stored.billAuthors)) {
        await replaceBillAuthors(db, billIds, rows);
        counts.authoredBills = rows.length;
      }
    }
  }

  return counts;
}

/**
 * The nightly window: the last `SPEECH_WINDOW_DAYS` of speeches (late transcriptions), this year's bulk files, and
 * every profile on Mondays (otherwise only deputies never fetched).
 */
export function nightlyWindow(now = new Date()): RefreshWindow {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    speechesFrom: day(new Date(now.getTime() - SPEECH_WINDOW_DAYS * 86_400_000)), to: day(now), year: now.getUTCFullYear(),
    profiles: now.getUTCDay() === 1 ? "all" : "missing",
  };
}
