import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHttpServer, type HttpDeps } from "./http.js";
import { MeaningIndexMissingError } from "./monitor/embedSpeeches.js";

let server: Server | undefined;
/** Speech keys as `speechKey()` stores them (deputy, start minute, 10 hex characters; ":n" for a repeated text). */
const K1 = "204407:2026-02-24T19:08:3f1a9c0b2e";
const K2 = "204407:2026-03-10T19:40:0123456789";
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(over: Partial<HttpDeps> = {}) {
  const deps: HttpDeps = {
    search: vi.fn(async () => [{ speechKey: "1:2026-03-01T10:00:abc", score: 0.9 }]),
    passages: vi.fn(async () => [{ speechKey: "1:2026-03-01T10:00:abc", sentences: ["Uma frase."], score: 0.8 }]),
    searchRecords: vi.fn(async () => [{ id: "2643915-8", score: 0.85 }]),
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
    expect((await post("/monitor/passages", { q: "saúde", speechKeys: [K1] })).status).toBe(503);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("POST /monitor/passages: perSpeech defaults to 3", async () => {
    const { deps, post } = await start();
    const res = await post("/monitor/passages", { q: "saúde", speechKeys: [K1, K2] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passages: [{ speechKey: "1:2026-03-01T10:00:abc", sentences: ["Uma frase."], score: 0.8 }] });
    expect(deps.passages).toHaveBeenLastCalledWith("saúde", [K1, K2], 3);
    await post("/monitor/passages", { q: "saúde", speechKeys: [K1], perSpeech: 99 });
    expect(deps.passages).toHaveBeenLastCalledWith("saúde", [K1], 10);
  });

  it("POST /monitor/passages: each speech key must have the stored key's shape, else 400", async () => {
    const { deps, post } = await start();
    for (const bad of ["a", "", "x".repeat(60_000), "204407:2026-02-24T19:08", "204407:2026-02-24T19:08:ABCDEF0123", `${K1}:x`, `${K1}\n`, 7]) {
      const res = await post("/monitor/passages", { q: "saúde", speechKeys: [K1, bad] });
      expect(res.status).toBe(400);
    }
    expect(deps.passages).not.toHaveBeenCalled();
    expect((await post("/monitor/passages", { q: "saúde", speechKeys: [`${K1}:2`] })).status).toBe(200);
  });

  it("POST /monitor/search with kind rollCalls / bills: scores the given ids only", async () => {
    const { deps, post } = await start();
    const res = await post("/monitor/search", { q: " aposentadoria ", kind: "rollCalls", ids: ["2643915-8", "2600708-7"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [{ id: "2643915-8", score: 0.85 }] });
    expect(deps.searchRecords).toHaveBeenLastCalledWith("roll_call", "aposentadoria", ["2643915-8", "2600708-7"], 100);
    await post("/monitor/search", { q: "x", kind: "bills", ids: ["2512345"], k: 999 });
    expect(deps.searchRecords).toHaveBeenLastCalledWith("bill", "x", ["2512345"], 200);
    expect(deps.search).not.toHaveBeenCalled();
    // speeches stay the default, and may be named
    await post("/monitor/search", { q: "x", kind: "speeches" });
    expect(deps.search).toHaveBeenLastCalledWith("x", 100);
  });

  it("400 on an unknown kind, or ids that are missing, too many or not that kind's ids", async () => {
    const { deps, post } = await start();
    for (const body of [
      { q: "x", kind: "deputies", ids: ["1"] },
      { q: "x", kind: "bills" },
      { q: "x", kind: "bills", ids: "1" },
      { q: "x", kind: "bills", ids: ["PL 1/2026"] },
      { q: "x", kind: "rollCalls", ids: ["2512345"] },
      { q: "x", kind: "bills", ids: Array.from({ length: 5001 }, (_, i) => String(i + 1)) },
      // roll-call ids are longer: at most 3,000 fit the 64 KB body
      { q: "x", kind: "rollCalls", ids: Array.from({ length: 3001 }, (_, i) => `${i + 1}-1`) },
      { q: "", kind: "bills", ids: ["1"] },
    ]) {
      const res = await post("/monitor/search", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(deps.searchRecords).not.toHaveBeenCalled();
  });

  it("record search: 3,000 roll-call ids fit the body; an index not built yet answers 404 (not 503: the worker is up)", async () => {
    const { deps, post } = await start({
      searchRecords: vi.fn(async (kind: string) => {
        if (kind === "bill") throw new MeaningIndexMissingError();
        return [];
      }),
    });
    const ids = Array.from({ length: 3000 }, (_, i) => `${2_600_000 + i}-${100 + (i % 900)}`);
    expect((await post("/monitor/search", { q: "x", kind: "rollCalls", ids })).status).toBe(200);
    expect(deps.searchRecords).toHaveBeenCalledTimes(1);
    const res = await post("/monitor/search", { q: "x", kind: "bills", ids: ["1"] });
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  it("413 on a body over 64 KB", async () => {
    const { post } = await start();
    expect((await post("/monitor/search", { q: "x".repeat(70_000) })).status).toBe(413);
  });
});
