import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { claimProxy, failProxy, finishProxy, PREVIEW_FAILED, requestProxy, settlePreview } from "./preview.ts";
import { createSession, getSession, setStage, updateSession, type Session } from "./repo.ts";

let db: Db;
let close: () => Promise<void>;
let s: Session;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await pool.end();
  s = await createSession(db, { title: "T", source: "upload" });
});

const status = async () => (await getSession(db, s.id))!.proxyStatus;

describe("the preview copy's row", () => {
  it("requestProxy is idempotent: pending, but never back from running or done", async () => {
    await requestProxy(db, s.id);
    expect(await status()).toBe("pending");
    await requestProxy(db, s.id);
    expect(await status()).toBe("pending");
    expect(await claimProxy(db, s.id)).toBe(true);
    await requestProxy(db, s.id);
    expect(await status()).toBe("running");
    await finishProxy(db, s.id, `${s.id}/proxy.mp4`);
    await requestProxy(db, s.id);
    expect(await status()).toBe("done");
  });

  it("requestProxy starts a failed copy over", async () => {
    await requestProxy(db, s.id);
    await claimProxy(db, s.id);
    await failProxy(db, s.id);
    expect(await status()).toBe("failed");
    await requestProxy(db, s.id);
    expect(await status()).toBe("pending");
  });

  it("claimProxy claims pending once; takeover also takes a running row", async () => {
    await requestProxy(db, s.id);
    const [a, b] = await Promise.all([claimProxy(db, s.id), claimProxy(db, s.id)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await claimProxy(db, s.id)).toBe(false);
    expect(await claimProxy(db, s.id, { takeover: true })).toBe(true);
    await finishProxy(db, s.id, "k");
    expect(await claimProxy(db, s.id, { takeover: true })).toBe(false);
  });

  it("finishProxy sets done and proxyKey in one update, only from running", async () => {
    expect(await finishProxy(db, s.id, "k")).toBe(false);
    await requestProxy(db, s.id);
    expect(await finishProxy(db, s.id, "k")).toBe(false);
    await claimProxy(db, s.id);
    expect(await finishProxy(db, s.id, `${s.id}/proxy.mp4`)).toBe(true);
    expect(await getSession(db, s.id)).toMatchObject({ proxyStatus: "done", proxyKey: `${s.id}/proxy.mp4` });
  });

  it("every step bumps updated_at", async () => {
    const t0 = (await getSession(db, s.id))!.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await requestProxy(db, s.id);
    const t1 = (await getSession(db, s.id))!.updatedAt.getTime();
    expect(t1).toBeGreaterThan(t0);
    await new Promise((r) => setTimeout(r, 20));
    await claimProxy(db, s.id);
    const t2 = (await getSession(db, s.id))!.updatedAt.getTime();
    expect(t2).toBeGreaterThan(t1);
    await new Promise((r) => setTimeout(r, 20));
    await finishProxy(db, s.id, "k");
    expect((await getSession(db, s.id))!.updatedAt.getTime()).toBeGreaterThan(t2);
  });
});

describe("settlePreview", () => {
  const waiting = async (patch: Partial<Session> = {}) => {
    await setStage(db, s.id, "preparing_preview", 96);
    await updateSession(db, s.id, patch);
  };

  it("preparing_preview with a done copy → ready 100", async () => {
    await waiting({ proxyStatus: "done", proxyKey: "k" });
    await settlePreview(db, s.id);
    expect(await getSession(db, s.id)).toMatchObject({ stage: "ready", progress: 100, error: null });
  });

  it("a session from before the change (status null, proxyKey set) is ready", async () => {
    await waiting({ proxyStatus: null, proxyKey: "k" });
    await settlePreview(db, s.id);
    expect((await getSession(db, s.id))!.stage).toBe("ready");
  });

  it("a copy still pending or running leaves the stage alone", async () => {
    await waiting({ proxyStatus: "running" });
    await settlePreview(db, s.id);
    expect((await getSession(db, s.id))!.stage).toBe("preparing_preview");
    await updateSession(db, s.id, { proxyStatus: null, proxyKey: null });
    await settlePreview(db, s.id);
    expect((await getSession(db, s.id))!.stage).toBe("preparing_preview");
  });

  it("a failed copy fails the session with the line", async () => {
    await waiting({ proxyStatus: "failed" });
    await settlePreview(db, s.id);
    expect(await getSession(db, s.id)).toMatchObject({ stage: "failed", error: PREVIEW_FAILED });
    expect(PREVIEW_FAILED).toBe("The video preview couldn't be prepared. Please try again.");
  });

  it("a stage changed between its read and its write (the sweep takes no advisory lock) is not overwritten", async () => {
    await waiting({ proxyStatus: "done", proxyKey: "k" });
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query("select id from sessions where id = $1 for update", [s.id]);
      const settling = settlePreview(db, s.id); // reads preparing_preview, then waits on the row lock to write
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like 'update \"sessions\"%'",
        );
        if (rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await other.query("update sessions set stage = 'failed', error = 'swept' where id = $1", [s.id]);
      await other.query("commit");
      await settling;
    } finally {
      other.release();
      await pool.end();
    }
    expect(await getSession(db, s.id)).toMatchObject({ stage: "failed", error: "swept" });
  });

  it("any other stage is never touched", async () => {
    for (const stage of ["transcribing", "awaiting_context", "ready", "failed"] as const) {
      await setStage(db, s.id, stage, 50);
      await updateSession(db, s.id, { proxyStatus: "failed" });
      await settlePreview(db, s.id);
      expect((await getSession(db, s.id))!.stage).toBe(stage);
    }
  });
});
