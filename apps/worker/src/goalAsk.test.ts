import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_QUEUE_FAILED, createDb, createSession, getSession, listAskMessages, setStage, updateSession, addAskMessage, type Db, type Session } from "@digestor/core/server";
import { startGoalAsk } from "./goalAsk.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("startGoalAsk", () => {
  let db: Db;
  let close: () => Promise<void>;
  let s: Session;
  beforeAll(() => {
    ({ db, close } = createDb(url!));
  });
  afterAll(() => close());
  beforeEach(async () => {
    s = await createSession(db, { title: "G", source: "upload" });
    await updateSession(db, s.id, { goal: "3 clips for Instagram" });
    await setStage(db, s.id, "ready", 100);
  });

  it("starts the goal as the first Ask question of a ready session", async () => {
    const enqueueAsk = vi.fn(async (_id: string) => {});
    expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("started");
    const [q, a] = await listAskMessages(db, s.ownerId, s.id);
    expect(q).toMatchObject({ role: "user", text: "3 clips for Instagram", status: "done" });
    expect(enqueueAsk).toHaveBeenCalledExactlyOnceWith(a!.id);
  });

  it("a second ready, a restart or a re-run never starts it twice", async () => {
    const enqueueAsk = vi.fn(async (_id: string) => {});
    const r = [await startGoalAsk({ db, enqueueAsk }, s.id), await startGoalAsk({ db, enqueueAsk }, s.id), await startGoalAsk({ db, enqueueAsk }, s.id)];
    expect(r).toEqual(["started", "skipped", "skipped"]);
    expect(await listAskMessages(db, s.ownerId, s.id)).toHaveLength(2);
    expect(enqueueAsk).toHaveBeenCalledTimes(1);
  });

  it("no goal or a blank goal: nothing starts", async () => {
    const enqueueAsk = vi.fn(async (_id: string) => {});
    for (const goal of [null, "  "]) {
      await updateSession(db, s.id, { goal });
      expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("skipped");
    }
    expect(await listAskMessages(db, s.ownerId, s.id)).toHaveLength(0);
    expect(enqueueAsk).not.toHaveBeenCalled();
  });

  it("skips a session that isn't ready, and starts once it is", async () => {
    const enqueueAsk = vi.fn(async (_id: string) => {});
    await setStage(db, s.id, "awaiting_context", 55);
    expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("skipped");
    await setStage(db, s.id, "failed", 55, "x");
    expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("skipped");
    await setStage(db, s.id, "ready", 100);
    expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("started");
    expect(await startGoalAsk({ db }, s.id)).toBe("skipped");
  });

  it("a session whose owner already asked something by hand is left alone", async () => {
    const enqueueAsk = vi.fn(async (_id: string) => {});
    await addAskMessage(db, { sessionId: s.id, ownerId: s.ownerId, role: "user", text: "hi", status: "done" });
    expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("skipped");
    expect(enqueueAsk).not.toHaveBeenCalled();
  });

  it("a failed enqueue leaves the session ready and shows the failed answer", async () => {
    const enqueueAsk = vi.fn(async (_id: string) => { throw new Error("down"); });
    expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("started");
    expect((await getSession(db, s.id))!.stage).toBe("ready");
    const [, a] = await listAskMessages(db, s.ownerId, s.id);
    expect(a).toMatchObject({ status: "failed", text: ASK_QUEUE_FAILED });
  });
});
