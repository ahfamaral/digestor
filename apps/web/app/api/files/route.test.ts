import { mkdirSync, writeFileSync, type ReadStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { GET } from "./[id]/[...file]/route";

// Records every fs stream the route opens, so a test can check the file gets closed.
const opened = vi.hoisted(() => [] as ReadStream[]);
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    const stream = fs.createReadStream(...args);
    opened.push(stream);
    return stream;
  }) as typeof fs.createReadStream;
  return { ...fs, default: { ...fs, createReadStream }, createReadStream };
});

let h: Harness;
let sessionId: string;
let clipId: string;
const proxy = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

beforeAll(async () => {
  h = createHarness();
  const s = await createSession(h.db, { title: "Talk", source: "upload" });
  sessionId = s.id;
  clipId = "11111111-1111-4111-8111-111111111111";
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

/** `file` is the URL path after `/api/files/<id>/`; Next hands it over as raw (still-encoded) segments. */
function get(file: string, init: { range?: string; query?: string; id?: string } = {}) {
  const id = init.id ?? sessionId;
  const req = new Request(`http://localhost/api/files/${id}/${file}${init.query ?? ""}`, {
    headers: init.range ? { Range: init.range } : {},
  });
  return GET(req, { params: Promise.resolve({ id, file: file.split("/") }) });
}

async function body(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("GET /api/files/[id]/[...file]", () => {
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

  it("serves thumbnails at /thumbs/<clipId>.jpg (and tolerates an encoded slash)", async () => {
    for (const file of [`thumbs/${clipId}.jpg`, `thumbs%2F${clipId}.jpg`]) {
      const res = await get(file);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
      expect(new TextDecoder().decode(await body(res))).toBe("jpg");
    }
  });

  it("serves clip renders and subtitles, as attachments when download=1", async () => {
    const mp4 = await get(`clips/${clipId}.mp4`);
    expect(mp4.headers.get("Content-Type")).toBe("video/mp4");
    expect(mp4.headers.get("Content-Disposition")).toBeNull();

    const srt = await get(`clips/${clipId}.srt`, { query: "?download=1" });
    expect(srt.status).toBe(200);
    expect(srt.headers.get("Content-Type")).toBe("application/x-subrip");
    expect(srt.headers.get("Content-Disposition")).toBe('attachment; filename="clip.srt"');

    const dl = await get(`clips/${clipId}.mp4`, { query: "?download=1" });
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="clip.mp4"');
  });

  it("rejects path traversal in file param", async () => {
    expect((await get("..%2Foriginal.mp4")).status).toBe(404);
    expect((await get("%2E%2E%2Foriginal.mp4")).status).toBe(404);
    expect((await get(`thumbs%2F..%2F..%2F${sessionId}%2Foriginal.mp4`)).status).toBe(404);
    expect((await get("../original.mp4")).status).toBe(404);
    expect((await get(`thumbs/../original.mp4`)).status).toBe(404);
    expect((await get(`clips/../../${sessionId}/original.mp4`)).status).toBe(404);
    expect((await get(`thumbs//${clipId}.jpg`)).status).toBe(404);
    expect((await get("proxy.mp4", { id: ".." })).status).toBe(404);
  });

  it("404s for files outside the allow-list, missing files and malformed encodings", async () => {
    expect((await get("original.mp4")).status).toBe(404);
    expect((await get(`thumbs/${clipId}.png`)).status).toBe(404);
    expect((await get(`clips/${clipId}.wav`)).status).toBe(404);
    expect((await get(`clips/${clipId}.mp4/extra`)).status).toBe(404);
    expect((await get("clips/00000000-0000-4000-8000-000000000000.mp4")).status).toBe(404);
    expect((await get("%E0%A4%A")).status).toBe(404);
    expect((await get("proxy.mp4", { id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });

  it("a client abort mid-stream closes the file and raises no error", async () => {
    const big = await createSession(h.db, { title: "Big", source: "upload" });
    mkdirSync(path.join(h.root, big.id), { recursive: true });
    writeFileSync(path.join(h.root, big.id, "proxy.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const errors: unknown[] = [];
    const onError = (err: unknown) => errors.push(err);
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    try {
      for (const range of [undefined, "bytes=1000-"]) {
        const res = await get("proxy.mp4", { id: big.id, range });
        const file = opened.at(-1)!;
        const reader = res.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel(); // what Next does when the browser drops the request
        if (!file.closed) await once(file, "close");
        expect(file.destroyed).toBe(true);
        await new Promise((r) => setTimeout(r, 50)); // let any late data/end events fire
      }
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    }
  });
});
