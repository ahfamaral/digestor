import { createDb, runMigrations } from "@digestor/core/server";

/** Migrate + truncate TEST_DATABASE_URL once per run (same job as core's and the worker's DB setup). */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  await runMigrations(url);
  const { db, close } = createDb(url);
  try {
    await db.execute("TRUNCATE sessions RESTART IDENTITY CASCADE");
  } finally {
    await close();
  }
}
