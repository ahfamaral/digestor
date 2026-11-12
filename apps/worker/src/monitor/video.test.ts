import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, replaceSpeechWindow, speechVideos, upsertMembers, upsertSessions, type Db } from "@digestor/core/server";
import { captionInfo, type Captions } from "../youtube/captions.js";
import { YouTubeDownloadError } from "../youtube/ytdlp.js";
import { fakeCamaraMonitorFetch } from "./fakeCamaraMonitor.js";
import { brasiliaLocal, runSessionVideos } from "./video.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/camara-video/${name}`, import.meta.url), "utf8");
const vtt = fixture("NmI46Y25mEU-first16min.pt-orig.vtt");
const info = JSON.parse(fixture("info-NmI46Y25mEU.recorded.json")) as unknown;
const speeches = JSON.parse(fixture("speeches-2026-06-30.json")) as { name: string; startsAt: string; text: string }[];

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE parl_speech_videos, parl_session_videos, parl_presence, parl_sessions, parl_speeches, parl_members RESTART IDENTITY CASCADE`);
});

async function seed() {
  await upsertSessions(db, [{ id: 82635, startsAt: "2026-06-30T14:24", description: "Sessão Deliberativa", status: "Encerrada" }]);
  const names = [...new Set(speeches.map((s) => s.name))];
  const ids = await upsertMembers(db, names.map((name, i) => ({ house: "camara" as const, externalId: i + 1, name, party: "PL", uf: "RS", photoUrl: null })));
  for (const [i, name] of names.entries()) {
    const rows = speeches.filter((s) => s.name === name).map((s) => ({
      startsAt: s.startsAt.replace(" ", "T").slice(0, 16), phase: "Breves Comunicações", kind: "Discurso", summary: "", text: s.text, keywords: "",
    }));
    await replaceSpeechWindow(db, ids.get(i + 1)!, "2026-06-30", "2026-06-30", rows);
  }
}
const sessionRow = async () =>
  (await db.execute<{ status: string; video_id: string | null; stream_start: string | null; spoken: number; matched: number; attempts: number; error: string | null; retry_at: string | null }>(
    sql`select status, video_id, stream_start::text, spoken, matched, attempts, error, retry_at from parl_session_videos where session_id = 82635`,
  )).rows[0]!;

describe("monitor.video", () => {
  it("brasiliaLocal is UTC minus 3 hours", () => {
    expect(brasiliaLocal(1782840271)).toBe("2026-06-30 14:24:31");
  });

  it("captionInfo reads the recorded info JSON of a finished stream", () => {
    expect(captionInfo(info)).toEqual({ startEpochS: 1782840271, durationS: 20736, live: false, wasLive: true });
    expect(captionInfo({ live_status: "is_live" }).live).toBe(true);
    // seen on 9 Jun 2026's plenary: uploaded 8 days later, not streamed
    expect(captionInfo({ live_status: "not_live", timestamp: 1781729466, duration: 23133 })).toEqual({ startEpochS: 1781729466, durationS: 23133, live: false, wasLive: false });
    expect(captionInfo(null)).toEqual({ startEpochS: null, durationS: null, live: false, wasLive: false });
  });

  it("finds the session's video, fetches its captions once and stores where each spoken speech is", async () => {
    await seed();
    const captions = vi.fn(async (): Promise<Captions> => ({ vtt, info: captionInfo(info) }));
    const { f } = fakeCamaraMonitorFetch();
    const out = await runSessionVideos({ db, fetch: f, captions });
    expect(captions).toHaveBeenCalledTimes(1);
    expect(captions).toHaveBeenCalledWith("NmI46Y25mEU");
    expect(out.results).toEqual(["82635: done 3/4"]);
    expect(await sessionRow()).toMatchObject({
      status: "done", video_id: "NmI46Y25mEU", stream_start: "2026-06-30 14:24:31", spoken: 4, matched: 3, error: null, retry_at: null,
    });
    const keys = (await db.execute<{ speech_key: string }>(sql`select speech_key from parl_speeches order by starts_at, id`)).rows.map((r) => r.speech_key);
    const v = await speechVideos(db, keys);
    expect(v.size).toBe(3);
    expect([...v.values()].every((x) => x.videoId === "NmI46Y25mEU" && x.endS > x.startS)).toBe(true);
    // nothing new: the next run claims nothing
    expect((await runSessionVideos({ db, fetch: f, captions })).results).toEqual([]);
  });

  it("a video uploaded after the session is anchored on the session's start, not on the upload time", async () => {
    await seed();
    const uploaded = { ...(info as object), live_status: "not_live", was_live: false, timestamp: 1783444271 }; // 8 days later
    const { f } = fakeCamaraMonitorFetch();
    const out = await runSessionVideos({ db, fetch: f, captions: async () => ({ vtt, info: captionInfo(uploaded) }) });
    expect(out.results).toEqual(["82635: done 3/4"]);
    const row = await sessionRow();
    expect(Math.abs(Date.parse(`${row.stream_start!.replace(" ", "T")}Z`) - Date.parse("2026-06-30T14:24:31Z"))).toBeLessThan(5 * 60_000);
  });

  it("an event without a video link waits and is looked at again", async () => {
    await seed();
    const { f } = fakeCamaraMonitorFetch({ "/eventos/82635": { dados: { id: 82635, urlRegistro: null } } });
    const now = new Date("2026-07-01T00:00:00Z");
    const out = await runSessionVideos({ db, fetch: f, captions: vi.fn(), now: () => now });
    expect(out.results).toEqual(["82635: no_video"]);
    expect(await sessionRow()).toMatchObject({ status: "no_video", retry_at: "2026-07-01 06:00:00+00" });
  });

  it("no captions yet, or a stream still live: waits", async () => {
    await seed();
    const { f } = fakeCamaraMonitorFetch();
    await runSessionVideos({ db, fetch: f, captions: async () => ({ vtt: null, info: captionInfo(info) }) });
    expect(await sessionRow()).toMatchObject({ status: "no_captions", video_id: "NmI46Y25mEU", error: expect.stringMatching(/no automatic captions/) });
  });

  it("a YouTube block is recorded with its friendly message, and the run doesn't throw", async () => {
    await seed();
    const { f } = fakeCamaraMonitorFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captions = async (): Promise<Captions> => {
      throw new YouTubeDownloadError("YouTube blocked this download from the server.", "ERROR: Sign in to confirm you're not a bot");
    };
    expect((await runSessionVideos({ db, fetch: f, captions })).results).toEqual(["82635: failed"]);
    expect(await sessionRow()).toMatchObject({ status: "failed", error: "YouTube blocked this download from the server.", attempts: 1 });
    warn.mockRestore();
  });

  it("a Câmara outage fails the session row, not the run", async () => {
    await seed();
    const { f } = fakeCamaraMonitorFetch({ "/eventos/82635": { status: 503 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await runSessionVideos({ db, fetch: f, captions: vi.fn() })).results).toEqual(["82635: failed"]);
    expect(await sessionRow()).toMatchObject({ status: "failed", error: "Matching the session's video failed." });
    warn.mockRestore();
  });
});
