import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIO_ONLY_WARNING, JOB_OPTIONS, QUEUES, UPLOAD_UNSUPPORTED } from "@digestor/core";
import { getSession, sessions } from "@digestor/core/server";
import { AUTH_COOKIE, authToken } from "@/lib/auth";
import { createHarness, type Harness } from "@/test/harness";
import { t } from "@/lib/i18n";
import { PUT } from "./route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => {
  h.send.mockClear();
  delete process.env.MAX_UPLOAD_GB;
  delete process.env.APP_PASSWORD;
});

function upload(query: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  return PUT(
    new Request(`http://localhost/api/sessions/upload?${query}`, {
      method: "PUT",
      body,
      headers,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
  );
}

const bytes = (n: number) => new Uint8Array(n).fill(7);

describe("PUT /api/sessions/upload", () => {
  it("rejects unsupported upload type", async () => {
    const res = await upload("filename=x.exe", bytes(10));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: UPLOAD_UNSUPPORTED });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("rejects a missing filename and a missing body", async () => {
    expect((await upload("", bytes(10))).status).toBe(400);
    const res = await upload("filename=a.mp4", null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No file was uploaded." });
  });

  it("upload stores original and enqueues start", async () => {
    const res = await upload(`filename=${encodeURIComponent("My Talk.final.MOV")}&hint=${encodeURIComponent("A panel on housing")}`, bytes(1234));
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const file = path.join(h.root, sessionId, "original.mov");
    expect(readFileSync(file).length).toBe(1234);

    const s = await getSession(h.db, sessionId);
    expect(s).toMatchObject({
      title: "My Talk.final",
      source: "upload",
      stage: "uploaded",
      originalKey: `${sessionId}/original.mov`,
      hint: "A panel on housing",
    });
    expect(h.send).toHaveBeenCalledWith(QUEUES.start, { sessionId }, { ...JOB_OPTIONS, singletonKey: sessionId });
  });

  it("stores the goal apart from the hint", async () => {
    const res = await upload(`filename=a.mp4&goal=${encodeURIComponent("3 clips on housing")}&hint=${encodeURIComponent("A panel")}`, bytes(10));
    const s = await getSession(h.db, ((await res.json()) as { sessionId: string }).sessionId);
    expect(s).toMatchObject({ goal: "3 clips on housing", hint: "A panel" });
  });

  it("an empty goal stores null", async () => {
    const res = await upload("filename=a.mp4", bytes(10));
    expect((await getSession(h.db, ((await res.json()) as { sessionId: string }).sessionId))?.goal).toBeNull();
  });

  it("a goal over 500 characters is a friendly 400 and creates no session", async () => {
    const res = await upload(`filename=a.mp4&goal=${"x".repeat(501)}`, bytes(10));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: t("upload.goalTooLong") });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("audio upload needs the acknowledgement", async () => {
    for (const ext of ["mp3", "m4a", "wav"]) {
      for (const query of [`filename=a.${ext}`, `filename=a.${ext}&audioOnlyAck=0`]) {
        const res = await upload(query, bytes(10));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "This file has no video. Clips will show a waveform instead of a picture." });
      }
    }
    expect(AUDIO_ONLY_WARNING).toBe("This file has no video. Clips will show a waveform instead of a picture.");
    expect(h.send).not.toHaveBeenCalled();

    const ok = await upload("filename=Radio.MP3&audioOnlyAck=1", bytes(50));
    expect(ok.status).toBe(200);
    const { sessionId } = (await ok.json()) as { sessionId: string };
    expect(readFileSync(path.join(h.root, sessionId, "original.mp3")).length).toBe(50);
    expect(await getSession(h.db, sessionId)).toMatchObject({ title: "Radio", audioOnlyAck: true, originalKey: `${sessionId}/original.mp3` });
    expect(h.send).toHaveBeenCalledWith(QUEUES.start, { sessionId }, { ...JOB_OPTIONS, singletonKey: sessionId });
  });

  it("a video upload leaves audioOnlyAck off, and the acknowledgement is not needed", async () => {
    const res = await upload("filename=a.mp4&audioOnlyAck=1", bytes(10));
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect((await getSession(h.db, sessionId))?.audioOnlyAck).toBe(false);
  });

  it("rejects uploads over the size cap", async () => {
    process.env.MAX_UPLOAD_GB = "0.000001"; // ~1 KB
    const res = await upload("filename=a.mp4", bytes(10), { "Content-Length": "5000" });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "This file is larger than the 0.000001 GB limit." });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("caps streamed bodies without a Content-Length and leaves nothing behind", async () => {
    process.env.MAX_UPLOAD_GB = "0.000001";
    const before = readdirSync(h.root).length;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(bytes(1000));
        c.close();
      },
    });
    const res = await upload("filename=a.webm", stream);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "This file is larger than the 0.000001 GB limit." });
    expect(readdirSync(h.root).length).toBe(before);
    expect(h.send).not.toHaveBeenCalled();
  });

  // The middleware skips this route (it would buffer the whole body), so the route checks the gate itself.
  it("enforces the password gate itself", async () => {
    process.env.APP_PASSWORD = "hunter2";
    const denied = await upload("filename=a.mp4", bytes(10));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "Unauthorized." });
    const ok = await upload("filename=a.mp4", bytes(10), { cookie: `${AUTH_COOKIE}=${await authToken("hunter2")}` });
    expect(ok.status).toBe(200);
  });

  it("stores a language override and rejects one outside the list", async () => {
    const ok = await upload("filename=a.mp4&language=pt", bytes(10));
    const { sessionId } = (await ok.json()) as { sessionId: string };
    expect((await getSession(h.db, sessionId))?.languageOverride).toBe("pt");
    const none = await upload("filename=a.mp4", bytes(10));
    expect((await getSession(h.db, ((await none.json()) as { sessionId: string }).sessionId))?.languageOverride).toBeNull();
    const before = readdirSync(h.root).length;
    for (const bad of ["xx", "PT", "pt-BR", ""]) {
      const res = await upload(`filename=a.mp4&language=${bad}`, bytes(10));
      if (bad === "") expect(res.status).toBe(200); // empty = detect automatically
      else {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Pick a language from the list." });
      }
    }
    expect(readdirSync(h.root).length).toBe(before + 1); // only the empty-value upload created a session
  });

  it("rejects an empty file and creates nothing", async () => {
    const before = readdirSync(h.root).length;
    const rows = (await h.db.select().from(sessions)).length;
    const res = await upload("filename=a.mp4", bytes(0));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That file is empty." });
    expect(readdirSync(h.root).length).toBe(before);
    expect((await h.db.select().from(sessions)).length).toBe(rows);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("leaves no row and no file when sending the start job fails", async () => {
    const before = readdirSync(h.root).length;
    const rows = (await h.db.select().from(sessions)).length;
    h.send.mockRejectedValueOnce(new Error("pg-boss down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload("filename=a.mp4", bytes(10));
    log.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "We couldn't start processing. Please try again." });
    expect(readdirSync(h.root).length).toBe(before);
    expect((await h.db.select().from(sessions)).length).toBe(rows);
  });
});
