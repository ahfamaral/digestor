import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSemanticCache, semanticSearch } from "./semantic";

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

  it("an empty query asks nothing", async () => {
    const f = ok([]);
    expect(await semanticSearch("  ", { fetch: f })).toEqual({ keys: [], ok: true });
    expect(f).not.toHaveBeenCalled();
  });
});
