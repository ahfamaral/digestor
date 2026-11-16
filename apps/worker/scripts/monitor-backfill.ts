/**
 * One-off load of the parliament monitor from 1 Feb 2026 (`MONITOR_FROM`) to today: every deputy who sat since then,
 * their history, speeches and profiles, the word counts of their speeches, and this year's roll calls, votes, guidance,
 * sessions, presence and bills. Safe to rerun (upserts and replaces); the nightly `monitor.refresh` job keeps it current
 * afterwards.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-backfill.ts
 *
 * `--words` only rebuilds the word counts from the stored speeches (no Câmara calls, about 15 s): after a deploy that
 * changes the stoplist or the counting.
 *
 * `--bill-mains` only reads this year's bills file again (main bills of opinions, substitutes and amendments,
 * migration 0033) and fetches every missing main-bill label from the API (about 4,900 calls the first time, 4 in
 * flight, 27 min in dev); reruns continue where it stopped. The full backfill does the same, uncapped.
 */
import { createDb, refreshWordCounts, upsertBills } from "@digestor/core/server";
import { BILL_COLUMNS, parseCsv, toBills } from "../src/monitor/bulk.js";
import { MONITOR_FROM, fetchYearCsv } from "../src/monitor/camara.js";
import { fillMainBillLabels, nightlyWindow, refreshMonitor } from "../src/monitor/refresh.js";

const { db, close } = createDb(process.env.DATABASE_URL!);
const started = Date.now();
const seconds = () => `in ${Math.round((Date.now() - started) / 1000)} s`;
try {
  if (process.argv.includes("--words")) {
    console.log("monitor word counts:", await refreshWordCounts(db), "rows", seconds());
  } else if (process.argv.includes("--bill-mains")) {
    const { year } = nightlyWindow();
    const bills = toBills(parseCsv(await fetchYearCsv(fetch, "proposicoes", year), BILL_COLUMNS));
    await upsertBills(db, bills);
    console.log(`monitor bills: ${bills.length} read, ${bills.filter((b) => b.mainBillLabel).length} main-bill labels from the file`, seconds());
    console.log("monitor main bills fetched:", await fillMainBillLabels({ db, fetch }, Infinity), seconds());
  } else {
    const { to, year } = nightlyWindow();
    const counts = await refreshMonitor({ db, fetch }, { speechesFrom: MONITOR_FROM, to, year, profiles: "all", mainBillFetches: Infinity });
    console.log("monitor backfill:", JSON.stringify(counts), seconds());
  }
} finally {
  await close();
}
