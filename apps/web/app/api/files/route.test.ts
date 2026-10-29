import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, replaceAiClips } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { GET } from "./[id]/[file]/route";

let h: Harness;
let sessionId: string;
let clipId: string;
const proxy = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

beforeAll(async () => {
  h = createHarness();
  const s = await createSession(h.db, { title: "Talk", source: "upload" });
  sessionId = s.id;
  const [clip] = await replaceAiClips(h.db, sessionId, [
    { title: "Heated: tax & spend?!", reason: "r", label: "heated", score: 90, startMs: 0, endMs: 60_000, children: [] },
  ]);
  clipId = clip!.id;
  const dir = path.join(h.root, sessionId);
  mkdirSync(path.join(dir, "thumbs"), { recursive: true });
  mkdirSync(path.join(dir, "clips"), { recursive: true });
  writeFileSync(path.join(dir, "proxy.mp4"), proxy);
  writeFileSync(path.join(dir, "original.mp4"), "secret");
  writeFileSync(path.join(dir, "thumbs", `${clipId}.jpg`), "jpg");
  writeFileSync(path.join(dir, "clips", `${clipId}.mp4`), "mp4");
  writeFileSync(path.join(dir, "clips", `${clipId}.srt`), "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
});
afterAll(() => h.cleanup());

/** `file` is passed the way Next hands over the raw segment of `/api/files/<id>/<file>`. */
function get(file: string, init: { range?: string; query?: string; id?: string } = {}) {
  const id = init.id ?? sessionId;
  const req = new Request(`http://localhost/api/files/${id}/${file}${init.query ?? ""}`, {
    headers: init.range ? { Range: init.range } : {},
  });
  return GET(req, { params: Promise.resolve({ id, file }) });
}

async function body(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("GET /api/files/[id]/[file]", () => {
  it("serves the whole proxy with range support advertised", async () => {
    const res = await get("proxy.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("1000");
    expect(await body(res)).toEqual(proxy);
  });

  it("serves partial content for Range requests", async () => {
    const res = await get("proxy.mp4", { range: "bytes=0-99" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toMatch(/^bytes 0-99\/\d+$/);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await body(res)).toEqual(proxy.slice(0, 100));
  });

  it("supports open-ended, suffix and over-long ranges", async () => {
    const open = await get("proxy.mp4", { range: "bytes=990-" });
    expect(open.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    expect(await body(open)).toEqual(proxy.slice(990));

    const suffix = await get("proxy.mp4", { range: "bytes=-100" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 900-999/1000");
    expect(await body(suffix)).toEqual(proxy.slice(900));

    const long = await get("proxy.mp4", { range: "bytes=950-5000" });
    expect(long.headers.get("Content-Range")).toBe("bytes 950-999/1000");
    expect((await body(long)).length).toBe(50);
  });

  it.each(["bytes=1000-", "bytes=5-2", "bytes=-0", "bytes=abc", "bytes=0-1,5-6", "items=0-1", "bytes=-"])(
    "answers 416 for unsatisfiable or invalid range %s",
    async (range) => {
      const res = await get("proxy.mp4", { range });
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */1000");
    },
  );

  it("serves thumbnails whose path arrives URL-encoded", async () => {
    for (const file of [`thumbs%2F${clipId}.jpg`, `thumbs/${clipId}.jpg`]) {
      const res = await get(file);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
      expect(new TextDecoder().decode(await body(res))).toBe("jpg");
    }
  });

  it("serves clip renders and subtitles, as attachments when download=1", async () => {
    const mp4 = await get(`clips%2F${clipId}.mp4`);
    expect(mp4.headers.get("Content-Type")).toBe("video/mp4");
    expect(mp4.headers.get("Content-Disposition")).toBeNull();

    const srt = await get(`clips%2F${clipId}.srt`, { query: "?download=1" });
    expect(srt.status).toBe(200);
    expect(srt.headers.get("Content-Type")).toBe("application/x-subrip");
    expect(srt.headers.get("Content-Disposition")).toBe('attachment; filename="Heated tax  spend.srt"');

    const dl = await get(`clips%2F${clipId}.mp4`, { query: "?download=1" });
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="Heated tax  spend.mp4"');
  });

  it("rejects path traversal in file param", async () => {
    expect((await get("..%2Foriginal.mp4")).status).toBe(404);
    expect((await get("%2E%2E%2Foriginal.mp4")).status).toBe(404);
    expect((await get(`thumbs%2F..%2F..%2F${sessionId}%2Foriginal.mp4`)).status).toBe(404);
    expect((await get("proxy.mp4", { id: ".." })).status).toBe(404);
  });

  it("404s for files outside the allow-list, missing files and malformed encodings", async () => {
    expect((await get("original.mp4")).status).toBe(404);
    expect((await get(`thumbs%2F${clipId}.png`)).status).toBe(404);
    expect((await get(`clips%2F${clipId}.wav`)).status).toBe(404);
    expect((await get("clips%2F00000000-0000-4000-8000-000000000000.mp4")).status).toBe(404);
    expect((await get("%E0%A4%A")).status).toBe(404);
    expect((await get("proxy.mp4", { id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });
});
