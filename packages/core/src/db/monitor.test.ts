import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { parlMembers, parlSpeeches } from "./schema.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE");
  await pool.end();
});

describe("monitor tables", () => {
  it("pt_unaccent matches across accents and plural", async () => {
    const [m] = await db
      .insert(parlMembers)
      .values({ house: "camara", externalId: 204407, name: "Fernanda Melchionna", nameNorm: "fernanda melchionna" })
      .returning();
    await db.insert(parlSpeeches).values({ memberId: m!.id, startsAt: "2026-03-17T18:00", text: "Os feminicídios no Rio Grande do Sul" });
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from parl_speeches where tsv @@ websearch_to_tsquery('pt_unaccent', 'feminicidio')`,
    );
    expect(r.rows[0]!.n).toBe(1);
  });
});
