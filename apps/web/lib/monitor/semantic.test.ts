import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSemanticCache, recordSearch, semanticSearch, speechPassages } from "./semantic";

const ok = (hits: { speechKey: string; score: number }[]) =>
  vi.fn(async () => new Response(JSON.stringify({ hits }), { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(() => clearSemanticCache());

describe("semanticSearch", () => {
  it("asks the worker for the top 100 and returns the keys in its order", async () => {
    const f = ok([{ speechKey: "a", score: 0.9 }, { speechKey: "b", score: 0.8 }]);
    expect(await semanticSearch("preço da comida", { fetch: f, url: "http://w:1" })).toEqual({ keys: ["a", "b"], ok: true });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://w:1/monitor/search");
    expect(JSON.parse(init.body as string)).toEqual({ q: "preço da comida", k: 100 });
  });

  it("caches per query (case and accents ignored)", async () => {
    const f = ok([{ speechKey: "a", score: 0.9 }]);
    await semanticSearch("Saúde", { fetch: f });
    await semanticSearch("saude", { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("after a failure the worker is left alone for 30 s (cached answers still serve), then asked again", async () => {
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      await semanticSearch("cached", { fetch: ok([{ speechKey: "c", score: 0.9 }]) });
      const down = vi.fn(async () => new Response("{}", { status: 503 }));
      expect(await semanticSearch("x", { fetch: down })).toEqual({ keys: [], ok: false });
      now.mockReturnValue(t0 + 29_000);
      expect(await semanticSearch("y", { fetch: down })).toEqual({ keys: [], ok: false });
      expect(down).toHaveBeenCalledTimes(1);
      expect(await semanticSearch("cached", { fetch: down })).toEqual({ keys: ["c"], ok: true });
      now.mockReturnValue(t0 + 31_000);
      const back = ok([{ speechKey: "a", score: 0.9 }]);
      expect(await semanticSearch("x", { fetch: back })).toEqual({ keys: ["a"], ok: true });
      expect(back).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("a worker that is down, slow or answers garbage gives ok: false, never a throw", async () => {
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await semanticSearch("a", { fetch: refused })).toEqual({ keys: [], ok: false });
    clearSemanticCache();
    const slow = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    expect(await semanticSearch("b", { fetch: slow as unknown as typeof fetch, timeoutMs: 20 })).toEqual({ keys: [], ok: false });
    clearSemanticCache();
    const garbage = vi.fn(async () => new Response(JSON.stringify({ hits: "no" }), { status: 200 }));
    expect(await semanticSearch("c", { fetch: garbage })).toEqual({ keys: [], ok: false });
    expect(slow).toHaveBeenCalledTimes(1);
    expect(garbage).toHaveBeenCalledTimes(1);
  });

  it("a timeout, a 404 or an odd body fails this search only; a refused connection or a 5xx pauses the worker 30 s", async () => {
    const slow = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    expect(await semanticSearch("slow", { fetch: slow as unknown as typeof fetch, timeoutMs: 20 })).toEqual({ keys: [], ok: false });
    expect(await semanticSearch("missing", { fetch: vi.fn(async () => new Response("{}", { status: 404 })) })).toEqual({ keys: [], ok: false });
    expect(await semanticSearch("odd", { fetch: vi.fn(async () => new Response("{}", { status: 200 })) })).toEqual({ keys: [], ok: false });
    const good = ok([{ speechKey: "a", score: 0.9 }]);
    expect(await semanticSearch("after", { fetch: good })).toEqual({ keys: ["a"], ok: true });
    expect(await speechPassages("q", ["a"], 1, { fetch: vi.fn(async () => new Response(JSON.stringify({ passages: [] }), { status: 200 })) })).toEqual({ ok: true, passages: [] });

    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await semanticSearch("refused", { fetch: refused })).toEqual({ keys: [], ok: false });
    expect(await semanticSearch("next", { fetch: good })).toEqual({ keys: [], ok: false });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("an empty query asks nothing", async () => {
    const f = ok([]);
    expect(await semanticSearch("  ", { fetch: f })).toEqual({ keys: [], ok: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("speechPassages", () => {
  const passage = { speechKey: "a", sentences: ["O preço subiu.", "A comida está cara."], score: 0.8 };

  it("asks the worker for the passages of these speeches and returns them in its order", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ passages: [passage] }), { status: 200 }));
    expect(await speechPassages("preço da comida", ["a", "b"], 1, { fetch: f, url: "http://w:1/" })).toEqual({ ok: true, passages: [passage] });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://w:1/monitor/passages");
    expect(JSON.parse(init.body as string)).toEqual({ q: "preço da comida", speechKeys: ["a", "b"], perSpeech: 1 });
  });

  it("no speeches asks nothing; a worker that is down or answers garbage gives ok: false and is left alone for 30 s", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 503 }));
    expect(await speechPassages("q", [], 1, { fetch: f })).toEqual({ ok: true, passages: [] });
    expect(f).not.toHaveBeenCalled();
    expect(await speechPassages("q", ["a"], 1, { fetch: f })).toEqual({ ok: false, passages: [] });
    const garbage = vi.fn(async () => new Response(JSON.stringify({ passages: [{ speechKey: 1 }] }), { status: 200 }));
    expect(await speechPassages("q", ["a"], 1, { fetch: garbage })).toEqual({ ok: false, passages: [] });
    expect(garbage).not.toHaveBeenCalled();
    clearSemanticCache();
    expect(await speechPassages("q", ["a"], 1, { fetch: garbage })).toEqual({ ok: false, passages: [] });
    expect(garbage).toHaveBeenCalledTimes(1);
  });

  it("a slow answer (timeout) doesn't stop the next searches; a refused connection or a 5xx does, for 30 s", async () => {
    const slow = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    expect(await speechPassages("q", ["a"], 1, { fetch: slow as unknown as typeof fetch, timeoutMs: 20 })).toEqual({ ok: false, passages: [] });
    const good = vi.fn(async () => new Response(JSON.stringify({ hits: [{ speechKey: "a", score: 0.9 }] }), { status: 200 }));
    expect(await semanticSearch("after timeout", { fetch: good })).toEqual({ keys: ["a"], ok: true });
    const passagesOk = vi.fn(async () => new Response(JSON.stringify({ passages: [passage] }), { status: 200 }));
    expect((await speechPassages("q", ["a"], 1, { fetch: passagesOk })).ok).toBe(true);
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await speechPassages("q", ["a"], 1, { fetch: refused })).ok).toBe(false);
    expect((await speechPassages("q", ["a"], 1, { fetch: passagesOk })).ok).toBe(false);
    expect(passagesOk).toHaveBeenCalledTimes(1);
  });
});

describe("recordSearch", () => {
  const hits = (h: { id: string; score: number }[]) =>
    vi.fn(async () => new Response(JSON.stringify({ hits: h }), { status: 200, headers: { "content-type": "application/json" } }));

  it("asks the worker to rank these roll calls or bills, and returns the hits in its order", async () => {
    const f = hits([{ id: "2-1", score: 0.86 }, { id: "1-1", score: 0.8 }]);
    expect(await recordSearch("rollCalls", "aposentadoria", ["1-1", "2-1"], { fetch: f, url: "http://w:1" })).toEqual({
      hits: [{ id: "2-1", score: 0.86 }, { id: "1-1", score: 0.8 }], ok: true,
    });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://w:1/monitor/search");
    expect(JSON.parse(init.body as string)).toEqual({ q: "aposentadoria", kind: "rollCalls", ids: ["1-1", "2-1"], k: 50 });
  });

  it("caches per kind, query and id list; no ids or no query asks nothing", async () => {
    const f = hits([{ id: "7", score: 0.9 }]);
    await recordSearch("bills", "Saúde", ["7", "8"], { fetch: f });
    await recordSearch("bills", "saude", ["7", "8"], { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
    await recordSearch("bills", "saude", ["7"], { fetch: f });
    await recordSearch("rollCalls", "saude", ["7-1"], { fetch: f });
    expect(f).toHaveBeenCalledTimes(3);
    expect(await recordSearch("bills", "saude", [], { fetch: f })).toEqual({ hits: [], ok: true });
    expect(await recordSearch("bills", " ", ["7"], { fetch: f })).toEqual({ hits: [], ok: true });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("a refused connection or a 5xx pauses the worker 30 s for the speech search too; a timeout or a 404 (index not built) fails this search only", async () => {
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await recordSearch("bills", "x", ["1"], { fetch: refused })).toEqual({ hits: [], ok: false });
    const never = ok([]);
    expect(await semanticSearch("y", { fetch: never })).toEqual({ keys: [], ok: false });
    expect(never).not.toHaveBeenCalled();
    clearSemanticCache();
    expect(await recordSearch("bills", "x", ["1"], { fetch: vi.fn(async () => new Response("{}", { status: 503 })) })).toEqual({ hits: [], ok: false });
    expect(await semanticSearch("y", { fetch: never })).toEqual({ keys: [], ok: false });
    expect(never).not.toHaveBeenCalled();
    clearSemanticCache();
    const asked = ok([{ speechKey: "a", score: 0.9 }]);
    expect(await recordSearch("bills", "x", ["1"], { fetch: vi.fn(async () => new Response("{}", { status: 404 })) })).toEqual({ hits: [], ok: false });
    expect(await semanticSearch("y", { fetch: asked })).toEqual({ keys: ["a"], ok: true });
    clearSemanticCache();
    const slow = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    expect(await recordSearch("bills", "z", ["1"], { fetch: slow as unknown as typeof fetch, timeoutMs: 20 })).toEqual({ hits: [], ok: false });
    expect(await semanticSearch("w", { fetch: asked })).toEqual({ keys: ["a"], ok: true });
    clearSemanticCache();
    const garbage = vi.fn(async () => new Response(JSON.stringify({ hits: [{ speechKey: "a", score: 1 }] }), { status: 200 }));
    expect(await recordSearch("bills", "x", ["1"], { fetch: garbage })).toEqual({ hits: [], ok: false });
  });
});
