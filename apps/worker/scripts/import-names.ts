/**
 * One-off backfill for sessions analysed before speaker names existed (Plan 3 Slice 1): their names live only in the
 * context card, so Who's who shows "No name yet" and their clips fail the `speaker` check. For every session with a
 * context card and no attribution rows at all, the card's grounded names become `proposed` attributions (as the
 * pipeline's context step does). Names the human typed in the old card also stay proposals: the journalist confirms
 * them in Who's who. Sessions that already have any attribution are skipped, so running it twice is safe.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/import-names.ts
 *
 * It runs in the worker container (which has the database URL) and never calls an LLM.
 */
import { createDb } from "@digestor/core/server";
import { importNamesForOldSessions } from "../src/pipeline/naming.js";

const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  const { imported } = await importNamesForOldSessions(db);
  for (const id of imported) console.log(`imported names for session ${id}`);
  console.log(imported.length === 0 ? "No sessions needed names." : `Read the context card names of ${imported.length} session(s).`);
} finally {
  await close();
}
