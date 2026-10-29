import { createDb, runMigrations } from "@digestor/core/server";

/**
 * Same job as packages/core/test/globalSetup.ts (migrate + truncate TEST_DATABASE_URL), but loaded through the
 * `@digestor/core/server` entrypoint: vitest cannot resolve core's bare imports (pg) when core's setup file is
 * referenced by path from this package.
 */
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
