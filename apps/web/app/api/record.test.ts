import { readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUEUES } from "@digestor/core";
import { createSession, getSessionRecord, sessions, suggestRecordRow, updateSession } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { GET as getRecord, POST as postRecord } from "./sessions/[id]/record/route";
import { POST as postYoutube } from "./sessions/youtube/route";
import { PUT as putUpload } from "./sessions/upload/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
beforeEach(() => h.send.mockClear());

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, ref: unknown, chamber?: unknown) =>
  postRecord(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ ref, chamber }) }), ctx(id));
const BAD = "Pick the house and paste the date, the sitting number or the official record link.";
const CAMARA = "https://www.camara.leg.br/evento-legislativo/12345";

describe("record route", () => {
  it("202 and one session.names send when the transcript exists; the row is pending with the ref", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    const res = await post(sessionId, "2026-10-21");
    expect(res.status).toBe(202);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.names, { sessionId }, expect.objectContaining({ retryLimit: expect.any(Number) }));
    const row = await getSessionRecord(h.db, sessionId);
    expect(row).toMatchObject({ status: "pending", chamber: "senado", ref: { chamber: "senado", date: "2026-10-21" } });
  });

  it("links without a send while there is no transcript yet (the graph picks it up)", async () => {
    const s = await createSession(h.db, { title: "T", source: "upload" });
    const res = await post(s.id, "21/10/2026");
    expect(res.status).toBe(202);
    expect(h.send).not.toHaveBeenCalled();
    expect((await getSessionRecord(h.db, s.id))?.ref).toMatchObject({ date: "2026-10-21" });
  });

  it("400 for a bad ref and nothing is stored", async () => {
    const { sessionId } = await seedReadySession(h.db);
    for (const ref of ["hello", "https://www25.senado.leg.br/web/atividade/plenario/-/sessao/123", "", 5]) {
      const res = await post(sessionId, ref);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: BAD });
    }
    expect(await getSessionRecord(h.db, sessionId)).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("202 for a Câmara ref: stored as a pending Câmara record and the job is sent", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const res = await post(sessionId, CAMARA);
    expect(res.status).toBe(202);
    expect(await getSessionRecord(h.db, sessionId)).toMatchObject({ status: "pending", chamber: "camara", ref: { chamber: "camara", eventId: "12345", url: CAMARA } });
    expect(h.send).toHaveBeenCalledTimes(1);
    const got = await getRecord(new Request("http://localhost/x"), ctx(sessionId));
    expect(await got.json()).toEqual({ status: "pending", error: null, chamber: "camara", date: null, url: CAMARA, retryAt: null });
  });

  it("404 for an unknown session", async () => {
    expect((await post("nope", "2026-10-21")).status).toBe(404);
    expect((await post("5f0c1c0e-3d1b-4b52-8d0a-111111111111", "2026-10-21")).status).toBe(404);
  });

  it("a failed send answers 503 and leaves the row pending", async () => {
    const { sessionId } = await seedReadySession(h.db);
    h.send.mockRejectedValueOnce(new Error("boom"));
    const res = await post(sessionId, "2026-10-21");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect((await getSessionRecord(h.db, sessionId))?.status).toBe("pending");
  });

  it("still links once the video is removed", async () => {
    const { sessionId } = await seedReadySession(h.db);
    await updateSession(h.db, sessionId, { videoDeletedAt: new Date() });
    expect((await post(sessionId, "2026-10-21")).status).toBe(202);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("GET: null when nothing is linked, then the status payload", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const none = await getRecord(new Request("http://localhost/x"), ctx(sessionId));
    expect(await none.json()).toBeNull();
    await post(sessionId, "2026-10-21");
    const got = await getRecord(new Request("http://localhost/x"), ctx(sessionId));
    expect(await got.json()).toEqual({
      status: "pending", error: null, chamber: "senado", date: "21/10/2026", url: "https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/20261021/20261021", retryAt: null,
    });
    expect((await getRecord(new Request("http://localhost/x"), ctx("nope"))).status).toBe(404);
  });
});

describe("record by house", () => {
  it("a sitting number with the Bundestag picked stores a Bundestag ref", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect((await post(sessionId, "21/103", "bundestag")).status).toBe(202);
    expect(await getSessionRecord(h.db, sessionId)).toMatchObject({ status: "pending", chamber: "bundestag", ref: { chamber: "bundestag", period: 21, sitting: 103 } });
    const got = await getRecord(new Request("http://localhost/x"), ctx(sessionId));
    expect(await got.json()).toMatchObject({ chamber: "bundestag", date: null, retryAt: null });
  });

  it("a date with no house stores the Senado ref, as before", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect((await post(sessionId, "2026-10-21")).status).toBe(202);
    expect((await getSessionRecord(h.db, sessionId))?.ref).toMatchObject({ chamber: "senado", date: "2026-10-21" });
  });

  it("a US date with the House picked is read as MM/DD/YYYY", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect((await post(sessionId, "10/21/2026", "us_house")).status).toBe(202);
    expect((await getSessionRecord(h.db, sessionId))?.ref).toMatchObject({ chamber: "us_house", date: "2026-10-21" });
  });

  it("a YouTube link is 400 with its own line; an unknown house is 400", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const yt = await post(sessionId, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(yt.status).toBe(400);
    expect(await yt.json()).toEqual({ error: "Paste the date or the official record link." });
    const xx = await post(sessionId, "2026-10-21", "xx");
    expect(xx.status).toBe(400);
    expect(await xx.json()).toEqual({ error: BAD });
    expect(await getSessionRecord(h.db, sessionId)).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("GET gives the retry time of a waiting row", async () => {
    const { sessionId } = await seedReadySession(h.db);
    await post(sessionId, "21/103", "bundestag");
    const { sessionRecords } = await import("@digestor/core/server");
    const retryAt = new Date("2026-11-05T06:00:00.000Z");
    await h.db.update(sessionRecords).set({ status: "waiting", retryAt });
    const got = await getRecord(new Request("http://localhost/x"), ctx(sessionId));
    expect(await got.json()).toMatchObject({ status: "waiting", retryAt: "2026-11-05T06:00:00.000Z" });
  });

  it("upload and youtube take the house too", async () => {
    const yt = await postYoutube(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", record: "21/103", chamber: "bundestag" }) }),
    );
    expect(yt.status).toBe(200);
    expect((await getSessionRecord(h.db, (await yt.json()).sessionId))?.ref).toMatchObject({ chamber: "bundestag", sitting: 103 });
    const bad = await putUpload(new Request("http://localhost/api/sessions/upload?filename=a.mp4&record=2026-10-21&chamber=xx", { method: "PUT", body: new Blob(["x"]), duplex: "half" } as RequestInit));
    expect(bad.status).toBe(400);
  });
});

describe("record at upload", () => {
  it("youtube: stores the ref after creating the session", async () => {
    const res = await postYoutube(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", record: "2026-10-21" }) }),
    );
    expect(res.status).toBe(200);
    const { sessionId } = await res.json();
    expect((await getSessionRecord(h.db, sessionId))).toMatchObject({ status: "pending", ref: { date: "2026-10-21" } });
  });

  it("youtube: a bad ref is 400 and no session starts", async () => {
    const res = await postYoutube(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", record: "nonsense" }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: BAD });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("youtube: a Câmara ref is accepted and stored", async () => {
    const res = await postYoutube(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", record: CAMARA }) }),
    );
    expect(res.status).toBe(200);
    const { sessionId } = await res.json();
    expect(await getSessionRecord(h.db, sessionId)).toMatchObject({ status: "pending", ref: { chamber: "camara", eventId: "12345" } });
  });

  const put = (qs: string) =>
    putUpload(new Request(`http://localhost/api/sessions/upload?${qs}`, { method: "PUT", body: new Blob(["x"]), duplex: "half" } as RequestInit));

  it("upload: stores a Câmara ref", async () => {
    const res = await put(`filename=a.mp4&record=${encodeURIComponent(CAMARA)}`);
    expect(res.status).toBe(200);
    const { sessionId } = await res.json();
    expect((await getSessionRecord(h.db, sessionId))?.ref).toMatchObject({ chamber: "camara", eventId: "12345" });
  });

  it("upload: stores the ref", async () => {
    const res = await put(`filename=a.mp4&record=${encodeURIComponent("2026-10-21")}`);
    expect(res.status).toBe(200);
    const { sessionId } = await res.json();
    expect((await getSessionRecord(h.db, sessionId))?.ref).toMatchObject({ date: "2026-10-21" });
  });

  it("upload: a bad ref is 400 before any file is saved", async () => {
    const sessionsBefore = (await h.db.select().from(sessions)).length;
    const filesBefore = readdirSync(h.root).length;
    const res = await put(`filename=a.mp4&record=nonsense`);
    expect((await h.db.select().from(sessions)).length).toBe(sessionsBefore);
    expect(readdirSync(h.root).length).toBe(filesBefore);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: BAD });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("accepting or dismissing a suggestion", () => {
  const ref = { chamber: "bundestag" as const, period: 21, sitting: 104, date: "2026-10-16", url: "https://www.bundestag.de/services/opendata" };
  const act = (id: string, action: string, r: unknown = ref) =>
    postRecord(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action, ref: r }) }), ctx(id));

  it("GET gives the suggested ref (only for a suggested row)", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    await suggestRecordRow(h.db, sessionId, ref);
    const got = await (await getRecord(new Request("http://localhost/x"), ctx(sessionId))).json();
    expect(got).toMatchObject({ status: "suggested", chamber: "bundestag", date: "16/10/2026", ref });
    await post(sessionId, "2026-10-21");
    expect(await (await getRecord(new Request("http://localhost/x"), ctx(sessionId))).json()).not.toHaveProperty("ref");
  });

  it("accept on a ready session: 202, the row is pending and one session.names is sent", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    await suggestRecordRow(h.db, sessionId, ref);
    const res = await act(sessionId, "accept");
    expect(res.status).toBe(202);
    expect((await getSessionRecord(h.db, sessionId))?.status).toBe("pending");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.names, { sessionId }, expect.anything());
  });

  it("a failed send on accept answers 503 and puts the row back to suggested", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    await suggestRecordRow(h.db, sessionId, ref);
    h.send.mockRejectedValueOnce(new Error("boom"));
    expect((await act(sessionId, "accept")).status).toBe(503);
    expect(await getSessionRecord(h.db, sessionId)).toMatchObject({ status: "suggested", ref });
    expect((await act(sessionId, "accept")).status).toBe(202);
  });

  it("accept at the context check sends nothing (the second graph step matches it)", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    await updateSession(h.db, sessionId, { stage: "awaiting_context" });
    await suggestRecordRow(h.db, sessionId, ref);
    expect((await act(sessionId, "accept")).status).toBe(202);
    expect((await getSessionRecord(h.db, sessionId))?.status).toBe("pending");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("accept before the transcript exists sends nothing", async () => {
    const s = await createSession(h.db, { title: "T", source: "upload" });
    await suggestRecordRow(h.db, s.id, ref);
    expect((await act(s.id, "accept")).status).toBe(202);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a stale ref is 409 and the row is untouched, for accept and dismiss", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    await suggestRecordRow(h.db, sessionId, ref);
    const stale = { ...ref, sitting: 105 };
    for (const action of ["accept", "dismiss"]) {
      const res = await act(sessionId, action, stale);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "That suggestion changed. Reload the page." });
    }
    expect(await getSessionRecord(h.db, sessionId)).toMatchObject({ status: "suggested", ref });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("dismiss deletes the row: 200", async () => {
    const { sessionId } = await seedReadySession(h.db, undefined, "parliament");
    await suggestRecordRow(h.db, sessionId, ref);
    expect((await act(sessionId, "dismiss")).status).toBe(200);
    expect(await getSessionRecord(h.db, sessionId)).toBeNull();
  });

  it("400 for an unknown action or a missing ref", async () => {
    const { sessionId } = await seedReadySession(h.db);
    expect((await act(sessionId, "nuke")).status).toBe(400);
    expect((await act(sessionId, "accept", "x")).status).toBe(400);
  });
});

describe("the upload note (hint) is capped", () => {
  const TOO_LONG = { error: "Keep the note to 2,000 characters or fewer." };
  const URL_ = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  it("youtube: 400 over 2,000 characters and no session starts; 2,000 is fine", async () => {
    const res = await postYoutube(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: URL_, hint: "a".repeat(2001) }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(TOO_LONG);
    expect(h.send).not.toHaveBeenCalled();
    const ok = await postYoutube(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: URL_, hint: "a".repeat(2000) }) }));
    expect(ok.status).toBe(200);
  });

  it("upload: 400 over 2,000 characters before the file is read", async () => {
    const res = await putUpload(
      new Request(`http://localhost/api/sessions/upload?filename=a.mp4&hint=${"a".repeat(2001)}`, { method: "PUT", body: new Blob(["x"]), duplex: "half" } as RequestInit),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(TOO_LONG);
    expect(h.send).not.toHaveBeenCalled();
  });
});
