import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RecordNotFoundError, fetchSenadoSpeeches, fetchSenador } from "./senado.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
const discursos = fx("senado-discursos-2026-09-02.json");
const textos = fx("senado-textos-2026-09-02.json").texts as Record<string, string>;
const senador = fx("senado-senador-5906.json");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Records the real routes: discursos list (JSON), texto-integral per speech (text/plain), senador (JSON). */
function fakeSenado(overrides: { list?: () => Response; text?: (id: string) => Response } = {}) {
  const calls: { url: string; accept: string | null }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, accept: new Headers(init?.headers).get("accept") });
    if (url.includes("/plenario/lista/discursos/")) return overrides.list?.() ?? json(discursos);
    const m = url.match(/texto-integral\/(\d+)$/);
    if (m) { const id = m[1] as string; return overrides.text?.(id) ?? new Response(textos[id] ?? "", { status: textos[id] ? 200 : 404 }); }
    if (url.includes("/senador/5906.json")) return json(senador);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("fetchSenadoSpeeches", () => {
  it("parses speeches in order with speaker codes and text", async () => {
    const { f, calls } = fakeSenado();
    const speeches = await fetchSenadoSpeeches("2026-09-02", null, f);
    // list is newest-first; external authors (no senator code) are dropped; ESP session starts at 10:00, DOR at 14:00
    expect(speeches.map((s) => s.id)).toEqual(["524179", "524182", "524138", "524139", "524142"]);
    expect(speeches.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    expect(speeches[2]!).toMatchObject({ officialId: "631", name: "Magno Malta", state: expect.any(String), party: expect.any(String) });
    expect(speeches[3]!.text).toContain("Obrigado, Presidente");
    expect(speeches[3]!.text).not.toMatch(/\n{3,}/);
    expect(speeches[0]!.text.length).toBeGreaterThan(100);
    expect(speeches.every((s) => s.textSource === "full")).toBe(true);
    expect(calls[0]!.url).toBe("https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/20260902/20260902.json");
    expect(calls.filter((c) => c.url.includes("texto-integral")).every((c) => c.accept === "text/plain")).toBe(true);
  });

  it("filters to the session when a code is given", async () => {
    const { f } = fakeSenado();
    const dor = await fetchSenadoSpeeches("2026-09-02", "587381", f);
    expect(dor.map((s) => s.id)).toEqual(["524138", "524139", "524142"]);
    const esp = await fetchSenadoSpeeches("2026-09-02", "583371", f);
    expect(esp.map((s) => s.id)).toEqual(["524179", "524182"]);
    await expect(fetchSenadoSpeeches("2026-09-02", "999", f)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("an empty day throws RecordNotFoundError", async () => {
    const empty = { DiscursosSessao: { Metadados: {}, Sessoes: null } };
    const { f } = fakeSenado({ list: () => json(empty) });
    await expect(fetchSenadoSpeeches("2026-10-27", null, f)).rejects.toBeInstanceOf(RecordNotFoundError);
    const notFound = fakeSenado({ list: () => json({ status: 404 }, 404) });
    await expect(fetchSenadoSpeeches("2026-10-27", null, notFound.f)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("a 5xx rethrows as a plain error (transient)", async () => {
    const { f } = fakeSenado({ list: () => new Response("boom", { status: 503 }) });
    const err = await fetchSenadoSpeeches("2026-09-02", null, f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const err2 = await fetchSenadoSpeeches("2026-09-02", null, down).catch((e) => e);
    expect(err2).not.toBeInstanceOf(RecordNotFoundError);
    const textDown = fakeSenado({ text: () => new Response("x", { status: 500 }) });
    await expect(fetchSenadoSpeeches("2026-09-02", null, textDown.f)).rejects.not.toBeInstanceOf(RecordNotFoundError);
  });

  it("accepts a single object where a list is expected, and falls back to the summary when a speech text is 404", async () => {
    const one = structuredClone(discursos);
    const sessions = one.DiscursosSessao.Sessoes.Sessao;
    const dor = sessions.find((s: { CodigoSessao: string }) => s.CodigoSessao === "587381");
    dor.Pronunciamentos.Pronunciamento = dor.Pronunciamentos.Pronunciamento[0];
    one.DiscursosSessao.Sessoes.Sessao = dor;
    const { f } = fakeSenado({ list: () => json(one), text: () => new Response("{}", { status: 404 }) });
    const speeches = await fetchSenadoSpeeches("2026-09-02", null, f);
    expect(speeches).toHaveLength(1);
    expect(speeches[0]!.text.length).toBeGreaterThan(20);
  });

  it("a 406 on the text (wrong Accept) throws a plain error instead of falling back", async () => {
    const { f } = fakeSenado({ text: () => new Response("{}", { status: 406 }) });
    const err = await fetchSenadoSpeeches("2026-09-02", null, f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
  });

  it("fetches texts with bounded concurrency", async () => {
    let live = 0;
    let peak = 0;
    const { f } = fakeSenado({
      text: (id) => {
        live++;
        peak = Math.max(peak, live);
        return new Response(textos[id] ?? "", { status: 200 });
      },
    });
    // the fake releases its slot after a delay, so overlapping calls are seen
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await f(input, init);
      if (String(input).includes("texto-integral")) {
        await new Promise((r) => setTimeout(r, 15));
        live--;
      }
      return res;
    }) as typeof fetch;
    await fetchSenadoSpeeches("2026-09-02", null, slow);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("fetchSenador", () => {
  it("parses name, party, UF and photo", async () => {
    const { f } = fakeSenado();
    expect(await fetchSenador("5906", f)).toEqual({
      officialId: "5906",
      displayName: "Dra. Eudócia",
      fullName: "Eudocia Maria Holanda de Araujo Caldas",
      party: "PSDB",
      state: "AL",
      photoUrl: "http://www.senado.leg.br/senadores/img/fotos-oficiais/senador5906.jpg",
    });
  });

  it("an unknown code (200 without Parlamentar) throws RecordNotFoundError", async () => {
    const f = (async () => json({ DetalheParlamentar: { Metadados: {} } })) as typeof fetch;
    await expect(fetchSenador("99999999", f)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("a 5xx is a plain error", async () => {
    const f = (async () => new Response("x", { status: 502 })) as typeof fetch;
    const err = await fetchSenador("5906", f).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
  });
});
