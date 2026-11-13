import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

/**
 * A Postgres pool that survives an idle client's error: when Postgres restarts, pg emits "error" on the pool for each
 * idle connection, and an EventEmitter with no "error" listener throws (the worker would crash). Logged; the pool opens
 * new connections on the next query.
 */
export function createPool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url });
  pool.on("error", (err) => console.error(`Postgres idle client error: ${err.message}`));
  return pool;
}

export function createDb(url: string): { db: Db; close(): Promise<void> } {
  const pool = createPool(url);
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
