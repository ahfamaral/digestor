import pg from "pg";
import { runMigrations } from "../src/db/migrate.ts";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  await runMigrations(url);
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  } finally {
    await pool.end();
  }
}
