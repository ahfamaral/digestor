import { beforeEach, describe, expect, it } from "vitest";
import { clearTranslateCache, translateQuery } from "./translateQuery";

type Call = { url: string; body: Record<string, unknown>; headers: Headers };

/** An OpenRouter chat-completions reply whose message content is `content` (json_schema answers come back as a JSON string). */
function fakeFetch(reply: string | (() => Promise<Response>), status = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    if (typeof reply === "function") return reply();
    const body = status === 200 ? { id: "gen-1", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] } : { error: { message: "boom" } };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const hanging = () =>
  ((async (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch);

beforeEach(() => clearTranslateCache());

describe("translateQuery", () => {
  it("turns an English query into Portuguese search terms", async () => {
    const { f, calls } = fakeFetch(JSON.stringify({ terms: ["feminicídio", "violência contra a mulher", "assassinato de mulheres"] }));
    const r = await translateQuery("femicide", { apiKey: "k", fetch: f });
    expect(r).toEqual({ terms: ["feminicídio", "violência contra a mulher", "assassinato de mulheres"], translated: true, failed: false });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
    expect(calls[0]!.headers.get("x-openrouter-title")).toBe("Digestor");
    const body = calls[0]!.body as { model: string; messages: { role: string; content: string }[]; response_format: { type: string }; provider: unknown };
    expect(body.model).toBe("anthropic/claude-haiku-5.5");
    expect(body).not.toHaveProperty("temperature");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "femicide" });
  });

  it("keeps at most 4 terms of at most 60 characters, deduplicated", async () => {
    const terms = ["a", "A ", "b", "x".repeat(200), "c", "d", "e", " "];
    const { f } = fakeFetch(JSON.stringify({ terms }));
    const r = await translateQuery("q", { apiKey: "k", fetch: f });
    expect(r.terms).toHaveLength(4);
    expect(r.terms.every((t) => t.length <= 60)).toBe(true);
    expect(r.terms[0]).toBe("a");
    expect(r.terms[1]).toBe("b");
  });

  it("a Portuguese query that comes back unchanged is not 'translated'", async () => {
    const { f } = fakeFetch(JSON.stringify({ terms: ["Feminicidio"] }));
    expect(await translateQuery("feminicídio", { apiKey: "k", fetch: f })).toEqual({ terms: ["Feminicidio"], translated: false, failed: false });
  });

  it("a Portuguese query kept first, with close terms added, is not 'translated' either", async () => {
    const { f } = fakeFetch(JSON.stringify({ terms: ["feminicídio", "violência contra a mulher"] }));
    expect(await translateQuery("feminicídio", { apiKey: "k", fetch: f })).toEqual({
      terms: ["feminicídio", "violência contra a mulher"], translated: false, failed: false,
    });
  });

  it("falls back to the words as typed on a server error, a timeout, a bad reply or no terms", async () => {
    const fallback = { terms: ["femicide"], translated: false, failed: true };
    expect(await translateQuery("femicide", { apiKey: "k", fetch: fakeFetch("", 500).f })).toEqual(fallback);
    expect(await translateQuery("femicide", { apiKey: "k", fetch: hanging(), timeoutMs: 20 })).toEqual(fallback);
    expect(await translateQuery("femicide", { apiKey: "k", fetch: fakeFetch("not json").f })).toEqual(fallback);
    expect(await translateQuery("femicide", { apiKey: "k", fetch: fakeFetch(JSON.stringify({ terms: [] })).f })).toEqual(fallback);
    expect(await translateQuery("femicide", { apiKey: "k", fetch: fakeFetch(JSON.stringify({ nope: 1 })).f })).toEqual(fallback);
  });

  it("caches successful translations, not failures", async () => {
    const ok = fakeFetch(JSON.stringify({ terms: ["feminicídio"] }));
    await translateQuery("Femicide ", { apiKey: "k", fetch: ok.f });
    await translateQuery("femicide", { apiKey: "k", fetch: ok.f });
    expect(ok.calls).toHaveLength(1);
    const bad = fakeFetch("", 500);
    await translateQuery("other", { apiKey: "k", fetch: bad.f });
    await translateQuery("other", { apiKey: "k", fetch: bad.f });
    expect(bad.calls).toHaveLength(2);
  });
});
