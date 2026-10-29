import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { LocalStorage, createDb, type Db } from "@digestor/core/server";
import { setServerForTests } from "@/lib/server";

export interface Harness {
  db: Db;
  storage: LocalStorage;
  root: string;
  send: ReturnType<typeof vi.fn>;
  cleanup(): Promise<void>;
}

/** Real test DB, temp-dir storage and a stub pg-boss sender, injected through the server test seam. */
export function createHarness(): Harness {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const { db, close } = createDb(url);
  const root = mkdtempSync(path.join(tmpdir(), "digestor-web-"));
  const storage = new LocalStorage(root);
  const send = vi.fn(async () => "job-id");
  setServerForTests({ db, storage, boss: { send } });
  return {
    db,
    storage,
    root,
    send,
    async cleanup() {
      setServerForTests(null);
      await close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
