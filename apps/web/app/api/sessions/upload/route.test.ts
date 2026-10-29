import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import { getSession } from "@digestor/core/server";
import { AUTH_COOKIE, authToken } from "@/lib/auth";
import { createHarness, type Harness } from "@/test/harness";
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
    expect(await res.json()).toEqual({ error: "Unsupported file type. Use MP4, MOV, MKV or WebM." });
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
});
