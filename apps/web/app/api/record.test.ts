import { readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUEUES } from "@digestor/core";
import { createSession, getSessionRecord, sessions, updateSession } from "@digestor/core/server";
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
const post = (id: string, ref: unknown) =>
  postRecord(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ ref }) }), ctx(id));
const BAD = "Paste a Senado session link with its date, or just the date.";
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

  it("422 for a Câmara ref, nothing stored", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const res = await post(sessionId, CAMARA);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Câmara records aren't supported yet." });
    expect(await getSessionRecord(h.db, sessionId)).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
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
      status: "pending", error: null, date: "21/10/2026", url: "https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/20261021/20261021",
    });
    expect((await getRecord(new Request("http://localhost/x"), ctx("nope"))).status).toBe(404);
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

  it("youtube: a Câmara ref is 422", async () => {
    const res = await postYoutube(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", record: CAMARA }) }),
    );
    expect(res.status).toBe(422);
    expect(h.send).not.toHaveBeenCalled();
  });

  const put = (qs: string) =>
    putUpload(new Request(`http://localhost/api/sessions/upload?${qs}`, { method: "PUT", body: new Blob(["x"]), duplex: "half" } as RequestInit));

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
