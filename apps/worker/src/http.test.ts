import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHttpServer, type HttpDeps } from "./http.js";
import { MeaningIndexMissingError } from "./monitor/embedSpeeches.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(over: Partial<HttpDeps> = {}) {
  const deps: HttpDeps = {
    search: vi.fn(async () => [{ speechKey: "1:2026-03-01T10:00:abc", score: 0.9 }]),
    passages: vi.fn(async () => [{ speechKey: "1:2026-03-01T10:00:abc", sentences: ["Uma frase."], score: 0.8 }]),
    ...over,
  };
  server = startHttpServer(deps, 0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { deps, base, post };
}

describe("worker HTTP", () => {
  it("GET /health answers ok", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /monitor/search: hits for the query, k defaults to 100 and is capped at 200", async () => {
    const { deps, post } = await start();
    const res = await post("/monitor/search", { q: "  preço da comida  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [{ speechKey: "1:2026-03-01T10:00:abc", score: 0.9 }] });
    expect(deps.search).toHaveBeenLastCalledWith("preço da comida", 100);
    await post("/monitor/search", { q: "x", k: 5000 });
    expect(deps.search).toHaveBeenLastCalledWith("x", 200);
    await post("/monitor/search", { q: "x", k: 7 });
    expect(deps.search).toHaveBeenLastCalledWith("x", 7);
  });

  it("400 on an empty or missing query, invalid JSON or bad keys; 404 elsewhere", async () => {
    const { deps, post, base } = await start();
    for (const body of [{ q: "   " }, {}, { q: 3 }, "not json"]) {
      const res = await post("/monitor/search", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect((await post("/monitor/passages", { q: "x", speechKeys: "a" })).status).toBe(400);
    expect((await post("/monitor/passages", { q: "x", speechKeys: Array.from({ length: 51 }, (_, i) => `k${i}`) })).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect(deps.search).not.toHaveBeenCalled();
  });

  it("503 JSON when the search fails (Chroma down, index missing), and the server keeps answering", async () => {
    const { post, base } = await start({
      search: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED chroma:8000");
      }),
      passages: vi.fn(async () => {
        throw new MeaningIndexMissingError();
      }),
    });
    const res = await post("/monitor/search", { q: "saúde" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/ECONNREFUSED/);
    expect((await post("/monitor/passages", { q: "saúde", speechKeys: ["a"] })).status).toBe(503);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("POST /monitor/passages: perSpeech defaults to 3", async () => {
    const { deps, post } = await start();
    const res = await post("/monitor/passages", { q: "saúde", speechKeys: ["a", "b"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passages: [{ speechKey: "1:2026-03-01T10:00:abc", sentences: ["Uma frase."], score: 0.8 }] });
    expect(deps.passages).toHaveBeenLastCalledWith("saúde", ["a", "b"], 3);
    await post("/monitor/passages", { q: "saúde", speechKeys: ["a"], perSpeech: 99 });
    expect(deps.passages).toHaveBeenLastCalledWith("saúde", ["a"], 10);
  });

  it("413 on a body over 64 KB", async () => {
    const { post } = await start();
    expect((await post("/monitor/search", { q: "x".repeat(70_000) })).status).toBe(413);
  });
});
