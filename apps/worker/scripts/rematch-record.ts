/**
 * Re-runs the record match of a session against its stored record ref (a regression check after a change to the
 * record code, or a re-match after a better matcher). It re-links the same ref (`linkRecord` with an unchanged ref keeps the
 * session's attributions, human rows included, and puts the row back to `pending`) and runs the record step.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/rematch-record.ts <sessionId>
 *
 * It runs in the worker container and calls the house's open-data API (free); it never calls an LLM.
 */
import { LocalStorage, createDb, getSessionRecord, linkRecord } from "@digestor/core/server";
import { runRecordStep } from "../src/pipeline/naming.js";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: rematch-record.ts <sessionId>");
  process.exit(1);
}
const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  const record = await getSessionRecord(db, sessionId);
  if (!record) {
    console.error(`Session ${sessionId} has no linked record.`);
    process.exitCode = 1;
  } else {
    await linkRecord(db, sessionId, record.ref);
    await runRecordStep({ db, storage: new LocalStorage(process.env.DATA_DIR ?? "/data") }, sessionId);
    const after = await getSessionRecord(db, sessionId);
    console.log(`record of ${sessionId} (${record.chamber}): ${after?.status}${after?.error ? ` - ${after.error}` : ""}`);
  }
} finally {
  await close();
}
