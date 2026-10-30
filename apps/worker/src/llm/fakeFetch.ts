/** Test helper: a fetch that records each request and answers with the next canned (status, body). */
export type SentRequest = { url: string; headers: Headers; body: any };

export function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const sent: SentRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next) throw new Error("fakeFetch: no reply left");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}
