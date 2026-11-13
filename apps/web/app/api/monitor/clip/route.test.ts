import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import {
  getSession, getSessionRecord, replaceSessionSpeechVideos, replaceSpeechWindow, sessions, speechesInRange, upsertMembers, upsertSessions,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { POST } from "./route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => {
  h.send.mockClear();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(
    "TRUNCATE parl_speech_videos, parl_session_videos, parl_sessions, parl_speeches, parl_members RESTART IDENTITY CASCADE",
  );
});

const DISABLED = "Clipping downloads the video from YouTube, which this server can't do. Open the monitor on your own computer to clip this speech.";

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/monitor/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** One plenary (event 81344, an 8 h 21 stream) with one speech placed at 6:47:16–6:48:53 in its video. */
async function seed(o: { startS?: number; endS?: number; durationS?: number | null; party?: string | null } = {}): Promise<string> {
  await upsertSessions(h.db, [{ id: 81344, startsAt: "2026-03-18T13:55", description: "Sessão Deliberativa Extraordinária", status: "Encerrada" }]);
  const ids = await upsertMembers(h.db, [{ house: "camara", externalId: 74171, name: "Chico Alencar", party: "PSOL", uf: "RJ", photoUrl: null }]);
  await replaceSpeechWindow(h.db, ids.get(74171)!, "2026-03-18", "2026-03-18", [
    { startsAt: "2026-03-18T21:04", phase: "Breves Comunicações", kind: "Discurso", summary: "", text: "O SR. CHICO ALENCAR - Sr. Presidente…", keywords: "" },
  ]);
  if (o.party !== undefined) await h.db.execute(`UPDATE parl_speeches SET party = ${o.party === null ? "NULL" : `'${o.party}'`}, uf = ${o.party === null ? "NULL" : "'RJ'"}`);
  const [speech] = await speechesInRange(h.db, "2026-03-18 00:00:00", "2026-03-18 23:59:59");
  await h.db.execute(
    `INSERT INTO parl_session_videos (session_id, video_id, status, duration_s) VALUES (81344, 'rWBN3MSNGXk', 'done', ${o.durationS === undefined ? 30060 : o.durationS === null ? "NULL" : o.durationS})`,
  );
  await replaceSessionSpeechVideos(h.db, 81344, "rWBN3MSNGXk", [{ speechKey: speech!.speechKey, startS: o.startS ?? 24436, endS: o.endS ?? 24533, score: 0.99 }]);
  return speech!.speechKey;
}

describe("POST /api/monitor/clip", () => {
  it("is off without MONITOR_CLIP_ENABLED=true: 403 with the sentence, no session, no job", async () => {
    const key = await seed();
    const rows = (await h.db.select().from(sessions)).length;
    for (const v of [undefined, "", "false", "1"]) {
      if (v === undefined) vi.stubEnv("MONITOR_CLIP_ENABLED", undefined as unknown as string);
      else vi.stubEnv("MONITOR_CLIP_ENABLED", v);
      const res = await post({ speechKey: key });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: DISABLED });
    }
    // in the monitor's language
    vi.stubEnv("MONITOR_CLIP_ENABLED", "false");
    const pt = await post({ speechKey: key }, { cookie: "monitor_lang=pt-BR" });
    expect(pt.status).toBe(403);
    expect((await pt.json()).error).toMatch(/^O recorte baixa o vídeo do YouTube/);
    expect((await h.db.select().from(sessions)).length).toBe(rows);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a speech with no video moment (or no such speech) answers 404", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    await seed();
    await h.db.execute("DELETE FROM parl_speech_videos");
    const [speech] = await speechesInRange(h.db, "2026-03-18 00:00:00", "2026-03-18 23:59:59");
    expect((await post({ speechKey: speech!.speechKey })).status).toBe(404);
    expect((await post({ speechKey: "nope" })).status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    expect((await post("not json")).status).toBe(400);
    expect((await post({ key: "x" })).status).toBe(400);
    expect((await post({ speechKey: "" })).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("creates a YouTube session for the speech's section (20 s either side), in Portuguese, with the hint and the record, and starts it once", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const key = await seed();
    const res = await post({ speechKey: key });
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(await getSession(h.db, sessionId)).toMatchObject({
      source: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=rWBN3MSNGXk",
      sourceStartMs: 24_416_000,
      sourceEndMs: 24_553_000,
      languageOverride: "pt",
      profile: null,
      stage: "uploaded",
      title: "Chico Alencar (PSOL-RJ), Câmara plenary, 2026-03-18",
      hint: "Câmara dos Deputados plenary: speech by Chico Alencar (PSOL-RJ) on 2026-03-18",
    });
    expect(await getSessionRecord(h.db, sessionId)).toMatchObject({
      chamber: "camara",
      ref: { chamber: "camara", eventId: "81344", url: "https://www.camara.leg.br/evento-legislativo/81344" },
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.start, { sessionId }, { ...JOB_OPTIONS, singletonKey: sessionId });
  });

  it("uses the party and state on the day, else today's", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const key = await seed({ party: "REDE" });
    const a = (await (await post({ speechKey: key })).json()) as { sessionId: string };
    expect((await getSession(h.db, a.sessionId))?.hint).toBe("Câmara dos Deputados plenary: speech by Chico Alencar (REDE-RJ) on 2026-03-18");
  });

  it("clamps the section at the video's start and end", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const key = await seed({ startS: 12, endS: 300, durationS: 310 });
    const { sessionId } = (await (await post({ speechKey: key })).json()) as { sessionId: string };
    expect(await getSession(h.db, sessionId)).toMatchObject({ sourceStartMs: 0, sourceEndMs: 310_000 });
  });

  it("without a known video length the end is the speech's end plus 20 s", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const key = await seed({ startS: 100, endS: 200, durationS: null });
    const { sessionId } = (await (await post({ speechKey: key })).json()) as { sessionId: string };
    expect(await getSession(h.db, sessionId)).toMatchObject({ sourceStartMs: 80_000, sourceEndMs: 220_000 });
  });

  it("refuses a part longer than 60 minutes with a friendly 422, and starts nothing", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const key = await seed({ startS: 1000, endS: 1000 + 3600 - 39 }); // 3,601 s with the 20 s either side
    const rows = (await h.db.select().from(sessions)).length;
    const res = await post({ speechKey: key });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "This speech runs over an hour, too long to clip here. Watch it on YouTube instead." });
    expect((await h.db.select().from(sessions)).length).toBe(rows);
    expect(h.send).not.toHaveBeenCalled();
    // exactly 60 minutes is fine
    await h.db.execute("UPDATE parl_speech_videos SET end_s = 1000 + 3600 - 40");
    expect((await post({ speechKey: key })).status).toBe(200);
  });

  it("leaves no row behind when sending the start job fails", async () => {
    vi.stubEnv("MONITOR_CLIP_ENABLED", "true");
    const key = await seed();
    const rows = (await h.db.select().from(sessions)).length;
    h.send.mockRejectedValueOnce(new Error("pg-boss down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ speechKey: key });
    log.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "We couldn't start processing. Please try again." });
    expect((await h.db.select().from(sessions)).length).toBe(rows);
  });
});
