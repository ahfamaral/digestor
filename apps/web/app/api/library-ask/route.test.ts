import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import { addLibraryAskMessage, createSession, deleteLibraryAskMessages, finishLibraryAskMessage, listLibraryAskMessages } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { GET, POST } from "./route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
beforeEach(async () => {
  await deleteLibraryAskMessages(h.db, (await listLibraryAskMessages(h.db, OWNER_ID)).map((m) => m.id));
});
afterEach(() => h.send.mockReset().mockImplementation(async () => "job-id"));

const req = (body: unknown) => new Request("http://localhost/api/library-ask", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("/api/library-ask", () => {
  it("POST stores the question and a pending answer and queues one job", async () => {
    const res = await POST(req({ question: "  What did they say about inflation? " }));
    expect(res.status).toBe(202);
    const msgs = await listLibraryAskMessages(h.db, OWNER_ID);
    expect(msgs.map((m) => [m.role, m.status, m.text])).toEqual([["user", "done", "What did they say about inflation?"], ["assistant", "pending", ""]]);
    expect(h.send).toHaveBeenCalledWith(QUEUES.askLibrary, { messageId: msgs[1]!.id }, { ...JOB_OPTIONS, singletonKey: msgs[1]!.id });
  });

  it("POST refuses bad questions, and a failed enqueue rolls both rows back with 503", async () => {
    for (const question of ["", "  ", "x".repeat(501), 5]) expect((await POST(req({ question }))).status).toBe(400);
    expect((await POST(req("not json"))).status).toBe(400);
    h.send.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req({ question: "again?" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect(await listLibraryAskMessages(h.db, OWNER_ID)).toHaveLength(0);
  });

  it("GET lists the conversation and which cited sessions still exist", async () => {
    const s = await createSession(h.db, { title: "Debate", source: "upload" });
    const gone = "00000000-0000-4000-8000-000000000001";
    await addLibraryAskMessage(h.db, { ownerId: OWNER_ID, role: "user", text: "Q?" });
    const a = await addLibraryAskMessage(h.db, { ownerId: OWNER_ID, role: "assistant", text: "", status: "pending" });
    await finishLibraryAskMessage(h.db, a.id, {
      text: "Said [S1 00:01:00] and [S2 00:02:00].",
      sources: [{ label: "S1", sessionId: s.id, title: "Debate" }, { label: "S2", sessionId: gone, title: "Deleted video" }],
      status: "done",
    });
    const body = await (await GET()).json();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(body.messages[1].sources).toHaveLength(2);
    expect(body.live).toEqual([s.id]);
  });

  it("GET returns an answer's videos not searched, and counts them as live while they exist", async () => {
    const waiting = await createSession(h.db, { title: "Waiting", source: "upload" });
    const gone = "00000000-0000-4000-8000-000000000002";
    await addLibraryAskMessage(h.db, { ownerId: OWNER_ID, role: "user", text: "Q?" });
    const a = await addLibraryAskMessage(h.db, { ownerId: OWNER_ID, role: "assistant", text: "", status: "pending" });
    const notSearched = {
      retentionDays: 14,
      videos: [
        { sessionId: waiting.id, title: "Waiting", reason: "awaiting_context" as const },
        { sessionId: gone, title: "Deleted since", reason: "removed" as const },
      ],
    };
    await finishLibraryAskMessage(h.db, a.id, { text: "Nothing.", status: "done", notSearched });
    const body = await (await GET()).json();
    expect(body.messages[1].notSearched).toEqual(notSearched);
    expect(body.live).toEqual([waiting.id]);
  });
});
