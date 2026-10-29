import { PgBoss, type SendOptions } from "pg-boss";
import { LocalStorage, createDb, type Db } from "@digestor/core/server";
import { dataDir, loadRootEnv } from "./env";

/** The web process only enqueues jobs; the worker consumes them. */
export interface JobSender {
  send(name: string, data: object, options?: SendOptions): Promise<string | null>;
}

export interface Server {
  db: Db;
  storage: LocalStorage;
  boss: JobSender;
}

interface Singletons {
  db?: Db;
  storage?: LocalStorage;
  boss?: JobSender;
}

// Kept on globalThis so dev hot reloads reuse one pool / one pg-boss instead of leaking connections.
const g = globalThis as typeof globalThis & { __digestor?: Singletons };
const cache: Singletons = (g.__digestor ??= {});
let testOverride: Partial<Server> | null = null;

function databaseUrl(): string {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set on the server.");
  return url;
}

function createSender(): JobSender {
  // No supervision/maintenance or cron scheduling here: the worker owns those.
  const boss = new PgBoss({ connectionString: databaseUrl(), supervise: false, schedule: false });
  boss.on("error", (err) => console.error("pg-boss:", err));
  let started: Promise<unknown> | null = null;
  return {
    async send(name, data, options) {
      started ??= boss.start().catch((err: unknown) => {
        started = null; // let the next request retry
        throw err;
      });
      await started;
      return boss.send(name, data, options);
    },
  };
}

/** Lazy singletons for route handlers: db, file storage and a send-only pg-boss. */
export function getServer(): Server {
  const o = testOverride;
  return {
    get db() {
      if (o?.db) return o.db;
      loadRootEnv();
      return (cache.db ??= createDb(databaseUrl()).db);
    },
    get storage() {
      if (o?.storage) return o.storage;
      loadRootEnv();
      return (cache.storage ??= new LocalStorage(dataDir()));
    },
    get boss() {
      return o?.boss ?? (cache.boss ??= createSender());
    },
  };
}

/** Test seam: route tests inject a test DB, temp storage and a stub sender; `null` restores the real ones. */
export function setServerForTests(override: Partial<Server> | null): void {
  testOverride = override;
}
