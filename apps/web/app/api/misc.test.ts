import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import {
  completeAnalysisVersion, createAskAction, getAskMessage, listAskMessages, listProblemReports, listSelections, saveTranslation,
  startAnalysisVersion, createSession, updateSession, getTranslation, addAskMessage, getMoment, setMomentChecks,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { GET as getAsk, POST as postAsk } from "./sessions/[id]/ask/route";
import { POST as postAction } from "./ask-actions/[id]/route";
import { GET as getTranslationRoute, POST as postTranslation } from "./analyses/[id]/translations/route";
import { POST as reanalyze } from "./sessions/[id]/reanalyze/route";
import { GET as getReports, POST as postReport } from "./reports/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => h.send.mockReset().mockImplementation(async () => "job-id"));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown, method = "POST") => new Request("http://localhost/x", { method, body: JSON.stringify(body) });
const cleanChecks = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};

describe("Ask", () => {
  it("ask creates a pending answer and one job", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const res = await postAsk(req({ question: "  Who spoke first? " }), ctx(sessionId));
    expect(res.status).toBe(202);
    const msgs = await listAskMessages(h.db, OWNER_ID, sessionId);
    expect(msgs.map((m) => [m.role, m.status, m.text])).toEqual([["user", "done", "Who spoke first?"], ["assistant", "pending", ""]]);
    expect(msgs[0]!.createdAt.getTime()).toBeLessThanOrEqual(msgs[1]!.createdAt.getTime());
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.ask, { messageId: msgs[1]!.id }, { ...JOB_OPTIONS, singletonKey: msgs[1]!.id });

    const list = await (await getAsk(new Request("http://localhost/x"), ctx(sessionId))).json();
    expect(list.messages).toHaveLength(2);
  });

  it("refuses bad questions and unready sessions; a failed enqueue rolls both rows back with 503", async () => {
    const { sessionId } = await seedReadySession(h.db);
    for (const question of ["", "   ", "x".repeat(501), 5]) expect((await postAsk(req({ question }), ctx(sessionId))).status).toBe(400);
    expect((await postAsk(req({ question: "x".repeat(500) }), ctx(sessionId))).status).toBe(202);
    h.send.mockRejectedValueOnce(new Error("boom"));
    const res = await postAsk(req({ question: "again?" }), ctx(sessionId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect(await listAskMessages(h.db, OWNER_ID, sessionId)).toHaveLength(2);
    await updateSession(h.db, sessionId, { stage: "finding_moments" });
    expect((await postAsk(req({ question: "hi" }), ctx(sessionId))).status).toBe(409);
    expect((await postAsk(req({ question: "hi" }), ctx("nope"))).status).toBe(404);
  });
});

describe("POST /api/ask-actions/[id]", () => {
  async function actionFor(status: "approved" | "rejected" | null, count = 2) {
    const { sessionId, moments } = await seedReadySession(h.db, [[10_000, 30_000], [40_000, 60_000], [70_000, 90_000]]);
    const msg = await addAskMessage(h.db, { sessionId, ownerId: OWNER_ID, role: "assistant", text: "Found some", status: "done" });
    const ids = moments.slice(0, count).map((m) => m.id);
    const action = await createAskAction(h.db, { messageId: msg.id, kind: "bulk_selection", payload: { momentIds: ids, status } });
    return { sessionId, moments, ids, action, msg };
  }

  it("confirming an action applies all selections once", async () => {
    const { sessionId, ids, action } = await actionFor("approved");
    const res = await postAction(req({ decision: "confirm" }), ctx(action.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed", applied: 2 });
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({ [ids[0]!]: "approved", [ids[1]!]: "approved" });
    // approving queues a check for moments without checks
    expect(h.send.mock.calls.filter((c) => c[0] === QUEUES.checkMoment)).toHaveLength(2);
    const second = await postAction(req({ decision: "confirm" }), ctx(action.id));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "This suggestion was already handled." });
  });

  it("two parallel confirms apply once (the loser gets 409)", async () => {
    const { action } = await actionFor("rejected");
    const [a, b] = await Promise.all([postAction(req({ decision: "confirm" }), ctx(action.id)), postAction(req({ decision: "confirm" }), ctx(action.id))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("status null sends the moments back to proposed", async () => {
    const { sessionId, ids, action } = await actionFor(null);
    const { setSelection } = await import("@digestor/core/server");
    for (const id of ids) await setSelection(h.db, OWNER_ID, id, "approved");
    expect((await postAction(req({ decision: "confirm" }), ctx(action.id))).status).toBe(200);
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({});
  });

  it("dismiss changes nothing else; a dismissed action can't be confirmed", async () => {
    const { sessionId, action } = await actionFor("approved");
    expect(await (await postAction(req({ decision: "dismiss" }), ctx(action.id))).json()).toEqual({ status: "dismissed" });
    expect((await postAction(req({ decision: "confirm" }), ctx(action.id))).status).toBe(409);
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({});
  });

  it("ignores moments of another video, refuses someone else's action and bad bodies", async () => {
    const { ids, action } = await actionFor("approved", 1);
    const other = await seedReadySession(h.db);
    const stray = await createAskAction(h.db, {
      messageId: action.messageId, kind: "bulk_selection", payload: { momentIds: [ids[0]!, other.moments[0]!.id], status: "approved" },
    });
    expect(await (await postAction(req({ decision: "confirm" }), ctx(stray.id))).json()).toEqual({ status: "confirmed", applied: 1 });
    expect(await listSelections(h.db, OWNER_ID, other.sessionId)).toEqual({});

    const foreign = await seedReadySession(h.db);
    const fmsg = await addAskMessage(h.db, { sessionId: foreign.sessionId, ownerId: "someone-else", role: "assistant", text: "x", status: "done" });
    const fa = await createAskAction(h.db, { messageId: fmsg.id, kind: "bulk_selection", payload: { momentIds: [], status: "approved" } });
    expect((await postAction(req({ decision: "confirm" }), ctx(fa.id))).status).toBe(404);
    expect((await postAction(req({ decision: "maybe" }), ctx(action.id))).status).toBe(400);
    expect((await postAction(req({ decision: "confirm" }), ctx("nope"))).status).toBe(404);
  });

  it("does not queue checks for moments that already have them", async () => {
    const { ids, action } = await actionFor("approved", 1);
    await setMomentChecks(h.db, ids[0]!, cleanChecks);
    await postAction(req({ decision: "confirm" }), ctx(action.id));
    expect(h.send).not.toHaveBeenCalled();
    expect((await getMoment(h.db, ids[0]!))?.checks).not.toBeNull();
    expect((await getAskMessage(h.db, action.messageId))?.status).toBe("done");
  });
});

describe("briefing translations", () => {
  it("translation POST enqueues; GET 404 until saved", async () => {
    const { analysisId } = await seedReadySession(h.db);
    const get = (language: string) => getTranslationRoute(new Request(`http://localhost/x?language=${language}`), ctx(analysisId));
    expect((await get("pt")).status).toBe(404);

    const res = await postTranslation(req({ language: "pt" }), ctx(analysisId));
    expect(res.status).toBe(202);
    expect(h.send).toHaveBeenCalledWith(
      QUEUES.translateBriefing, { analysisId, language: "pt" }, { ...JOB_OPTIONS, singletonKey: `${analysisId}:pt` },
    );
    expect(await (await get("pt")).json()).toEqual({ status: "pending" });

    await saveTranslation(h.db, analysisId, "pt", "briefing", { lead: [] });
    expect(await (await get("pt")).json()).toEqual({ status: "ready", content: { lead: [] } });
    h.send.mockClear();
    const again = await postTranslation(req({ language: "pt" }), ctx(analysisId));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "ready", content: { lead: [] } });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a failed translation reports its error and a new POST resets it to pending", async () => {
    const { analysisId } = await seedReadySession(h.db);
    const { failTranslation, requestTranslation } = await import("@digestor/core/server");
    await requestTranslation(h.db, analysisId, "fr", "briefing");
    await failTranslation(h.db, analysisId, "fr", "briefing", "Couldn't translate the briefing. Please try again.");
    const body = await (await getTranslationRoute(new Request("http://localhost/x?language=fr"), ctx(analysisId))).json();
    expect(body).toEqual({ status: "failed", error: "Couldn't translate the briefing. Please try again." });
    expect((await postTranslation(req({ language: "fr" }), ctx(analysisId))).status).toBe(202);
    expect(await getTranslation(h.db, analysisId, "fr", "briefing")).toEqual({ status: "pending", content: null, error: null });
  });

  it("refuses unknown languages, unknown or running analyses, and rolls back on enqueue failure", async () => {
    const { analysisId, sessionId } = await seedReadySession(h.db);
    expect((await postTranslation(req({ language: "xx" }), ctx(analysisId))).status).toBe(400);
    expect((await postTranslation(req({}), ctx(analysisId))).status).toBe(400);
    expect((await getTranslationRoute(new Request("http://localhost/x?language=xx"), ctx(analysisId))).status).toBe(400);
    expect((await postTranslation(req({ language: "pt" }), ctx("nope"))).status).toBe(404);
    expect((await postTranslation(req({ language: "pt" }), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);

    h.send.mockRejectedValueOnce(new Error("boom"));
    expect((await postTranslation(req({ language: "de" }), ctx(analysisId))).status).toBe(503);
    expect(await getTranslation(h.db, analysisId, "de", "briefing")).toBeNull();

    const running = await startAnalysisVersion(h.db, sessionId, { profile: "interview", reason: "x", models: {}, promptVersions: {} });
    expect((await postTranslation(req({ language: "pt" }), ctx(running.id))).status).toBe(409);
  });
});

describe("POST /api/sessions/[id]/reanalyze", () => {
  it("reanalyze refuses while a version is running", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const ok = await reanalyze(req({ profile: "parliament" }), ctx(sessionId));
    expect(ok.status).toBe(202);
    expect(h.send).toHaveBeenCalledWith(
      QUEUES.reanalyze,
      { sessionId, profile: "parliament", reason: "Re-analysed as Parliament" },
      { ...JOB_OPTIONS, singletonKey: `reanalyze:${sessionId}` },
    );
    const v = await startAnalysisVersion(h.db, sessionId, { profile: "parliament", reason: "x", models: {}, promptVersions: {} });
    h.send.mockClear();
    const res = await reanalyze(req({ profile: "parliament" }), ctx(sessionId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A re-analysis is already running for this video." });
    expect(h.send).not.toHaveBeenCalled();
    await completeAnalysisVersion(h.db, v.id);
    expect((await reanalyze(req({ profile: "un", reason: "Wrong kind" }), ctx(sessionId))).status).toBe(202);
    expect(h.send).toHaveBeenCalledWith(QUEUES.reanalyze, { sessionId, profile: "un", reason: "Wrong kind" }, expect.anything());
  });

  it("validates the profile, readiness and the enqueue", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect((await reanalyze(req({ profile: "nope" }), ctx(sessionId))).status).toBe(400);
    expect((await reanalyze(req({}), ctx(sessionId))).status).toBe(400);
    expect((await reanalyze(req({ profile: "other" }), ctx("nope"))).status).toBe(404);
    h.send.mockRejectedValueOnce(new Error("boom"));
    expect((await reanalyze(req({ profile: "other" }), ctx(sessionId))).status).toBe(503);
    await updateSession(h.db, sessionId, { stage: "failed" });
    expect((await reanalyze(req({ profile: "other" }), ctx(sessionId))).status).toBe(409);
  });
});

describe("problem reports", () => {
  it("report stores the target", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
    const res = await postReport(req({ sessionId, targetKind: "moment", targetId: moments[0]!.id, note: "  Wrong speaker " }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ sessionId, targetKind: "moment", targetId: moments[0]!.id, note: "Wrong speaker", ownerId: OWNER_ID });
    expect((await postReport(req({ sessionId, targetKind: "briefing", targetId: "x" }))).status).toBe(201);
    expect((await listProblemReports(h.db, OWNER_ID)).filter((r) => r.sessionId === sessionId)).toHaveLength(2);
    const list = await (await getReports()).json();
    expect(list.reports.filter((r: { sessionId: string }) => r.sessionId === sessionId).map((r: { targetKind: string }) => r.targetKind)).toEqual(["briefing", "moment"]);
  });

  it("refuses bad bodies and unknown sessions", async () => {
    const { sessionId } = await seedReadySession(h.db);
    for (const body of [
      { sessionId, targetKind: "nope", targetId: "x" }, { sessionId, targetKind: "moment" }, { sessionId: "nope", targetKind: "moment", targetId: "x" },
      { sessionId, targetKind: "moment", targetId: "x", note: "n".repeat(1001) },
    ]) expect((await postReport(req(body))).status).toBe(400);
    const gone = await postReport(req({ sessionId: "00000000-0000-4000-8000-000000000000", targetKind: "moment", targetId: "x" }));
    expect(gone.status).toBe(404);
    const s = await createSession(h.db, { title: "x", source: "upload" });
    expect((await postReport(req({ sessionId: s.id, targetKind: "clip", targetId: "x" }))).status).toBe(201);
  });
});
