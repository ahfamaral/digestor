/**
 * One-off clean-up for duplicate person rows: a custom person (typed in Who's who or proposed from a transcript) and
 * an official record person that carry the same name. The custom row is folded into the official one (attributions
 * repointed, the human-picked name kept), so the name shows once. Safe to run twice: a second run merges nothing.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/merge-persons.ts
 *
 * It runs in the worker container (which has the database URL) and never calls an LLM.
 */
import { createDb, mergeSameNamePersons } from "@digestor/core/server";

const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  const { merged } = await mergeSameNamePersons(db);
  console.log(`merged ${merged} duplicate person(s)`);
} finally {
  await close();
}
