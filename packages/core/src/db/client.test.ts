import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, createPool } from "./client.ts";

afterEach(() => vi.restoreAllMocks());

describe("Postgres pools survive an idle client's error", () => {
  // pg emits "error" on the pool when an idle client's connection drops (Postgres restarted); with no listener the
  // EventEmitter throws and the process crashes.
  const dropped = () => new Error("terminating connection due to administrator command");

  it("createDb's pool logs it instead of throwing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, close } = createDb("postgres://nobody@127.0.0.1:1/none");
    const pool = (db as unknown as { $client: pg.Pool }).$client; // drizzle keeps the pool here
    expect(() => pool.emit("error", dropped())).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]![0])).toContain("terminating connection");
    await close();
  });

  it("createPool (the worker's Ask checkpointer pool) does too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPool("postgres://nobody@127.0.0.1:1/none");
    expect(() => pool.emit("error", dropped())).not.toThrow();
    await pool.end();
  });
});
