import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { completeAnalysisVersion, startAnalysisVersion } from "./analysis.ts";
import { createSession, saveContextCard, updateSession } from "./repo.ts";
import {
  addLibraryAskMessage, claimLibraryAskMessage, deleteLibraryAskMessages, finishLibraryAskMessage, getLibraryAskMessage, listLibraryAskMessages,
  listLibraryCandidates, releaseLibraryAskMessage,
} from "./libraryAsk.ts";
import type { ContextCard } from "../schemas.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions, library_ask_messages RESTART IDENTITY CASCADE");
  await pool.end();
});

const fact = (value: string | null) => ({ value, source: "video" as const, confidence: 1, evidence: null });
const card = (summary: string, date: string | null = null): ContextCard => ({
  language: fact("en"),
  profile: { value: "interview", confidence: 1, evidence: null },
  title: fact(null),
  summary,
  setting: fact(null),
  dateOrYear: fact(date),
  participants: [],
  sufficient: true,
  openQuestions: [],
});

describe("library ask messages", () => {
  it("lists an owner's conversation oldest first", async () => {
    const q = await addLibraryAskMessage(db, { ownerId: "owner", role: "user", text: "What about inflation?" });
    const a = await addLibraryAskMessage(db, { ownerId: "owner", role: "assistant", text: "", status: "pending" });
    await addLibraryAskMessage(db, { ownerId: "someone", role: "user", text: "Other" });
    const list = await listLibraryAskMessages(db, "owner");
    expect(list.map((m) => m.id)).toEqual([q.id, a.id]);
    expect(a.status).toBe("pending");
    expect(q.status).toBe("done");
  });

  it("claims a pending answer once, releases it, and stores the answer with its sources", async () => {
    const a = await addLibraryAskMessage(db, { ownerId: "owner", role: "assistant", text: "", status: "pending" });
    expect(await claimLibraryAskMessage(db, a.id)).toBe(true);
    expect(await claimLibraryAskMessage(db, a.id)).toBe(false);
    await releaseLibraryAskMessage(db, a.id);
    expect((await getLibraryAskMessage(db, a.id))?.status).toBe("pending");
    expect(await claimLibraryAskMessage(db, a.id)).toBe(true);
    const sources = [{ label: "S1", sessionId: "7433d1c6-0000-4000-8000-000000000000", title: "Debate" }];
    const done = await finishLibraryAskMessage(db, a.id, { text: "They said [S1 00:01:00].", sources, toolCalls: [], status: "done" });
    expect(done).toMatchObject({ status: "done", text: "They said [S1 00:01:00].", sources });
    // Finished: a late claim does nothing.
    expect(await claimLibraryAskMessage(db, a.id)).toBe(false);
  });

  it("deletes messages by id", async () => {
    const q = await addLibraryAskMessage(db, { ownerId: "owner", role: "user", text: "Q" });
    await deleteLibraryAskMessages(db, [q.id]);
    expect(await getLibraryAskMessage(db, q.id)).toBeNull();
  });
});

describe("listLibraryCandidates", () => {
  it("offers only the owner's ready sessions whose video is still there, newest first, with profile and card", async () => {
    const old = await createSession(db, { title: "Old interview", source: "upload" });
    await updateSession(db, old.id, { stage: "ready", createdAt: new Date("2026-11-01T10:00:00Z") });
    await saveContextCard(db, old.id, card("A mayor on housing.", "2026"), 1);
    const v = await startAnalysisVersion(db, old.id, { profile: "interview", reason: "initial", models: {}, promptVersions: {} });
    await completeAnalysisVersion(db, v.id);

    const fresh = await createSession(db, { title: "Debate", source: "youtube" });
    await updateSession(db, fresh.id, { stage: "ready" });

    const removed = await createSession(db, { title: "Removed", source: "upload" });
    await updateSession(db, removed.id, { stage: "ready", videoDeletedAt: new Date() });
    const processing = await createSession(db, { title: "Processing", source: "upload" });
    await updateSession(db, processing.id, { stage: "transcribing" });
    const other = await createSession(db, { title: "Someone else's", source: "upload" });
    await updateSession(db, other.id, { stage: "ready", ownerId: "someone" });

    const rows = await listLibraryCandidates(db, "owner", 10);
    expect(rows.map((r) => r.id)).toEqual([fresh.id, old.id]);
    expect(rows[1]).toMatchObject({ title: "Old interview", profile: "interview", card: { summary: "A mayor on housing." } });
    expect(rows[0]).toMatchObject({ title: "Debate", profile: null, card: null });
    expect(await listLibraryCandidates(db, "owner", 1)).toHaveLength(1);
  });
});
