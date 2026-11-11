/**
 * One-off load of the parliament monitor from 1 Feb 2026 (`MONITOR_FROM`) to today: every deputy who sat since then,
 * their speeches, and this year's roll calls and votes. Safe to rerun (upserts and window replaces); the nightly
 * `monitor.refresh` job keeps it current afterwards.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-backfill.ts
 */
import { createDb } from "@digestor/core/server";
import { MONITOR_FROM } from "../src/monitor/camara.js";
import { nightlyWindow, refreshMonitor } from "../src/monitor/refresh.js";

const { db, close } = createDb(process.env.DATABASE_URL!);
const started = Date.now();
try {
  const { to, year } = nightlyWindow();
  const counts = await refreshMonitor({ db, fetch }, { speechesFrom: MONITOR_FROM, to, year });
  console.log("monitor backfill:", JSON.stringify(counts), `in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await close();
}
