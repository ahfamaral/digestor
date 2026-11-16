import { readFileSync } from "node:fs";

/**
 * A fake `fetch` over the recorded Câmara monitor fixtures (test/fixtures/camara-monitor, recorded 2026-11-11, see its
 * README). URLs are matched by path and query; anything else answers 404 like the API does for unknown ids.
 * `overrides` replaces a body by a URL substring (e.g. `{ "/deputados/204407/discursos": { dados: [], links: [] } }`);
 * `{ status: 404 }` (only a numeric `status`) answers that status instead.
 */
const dir = new URL("../../test/fixtures/camara-monitor/", import.meta.url);
export const monitorFixture = (name: string) => readFileSync(new URL(name, dir), "utf8");
const json = (name: string) => JSON.parse(monitorFixture(name)) as unknown;
/** Per-deputy fixtures served for `/deputados/{id}/{kind}`; other deputies answer an empty list. */
const RECORDED = new Set([
  "historico-204407", "historico-220576", "historico-73806", "profissoes-204407", "mandatosExternos-204407", "frentes-204407", "orgaos-204407",
]);

const isStatus = (b: unknown): b is { status: number } =>
  typeof b === "object" && b !== null && Object.keys(b).length === 1 && typeof (b as { status?: unknown }).status === "number";

export function fakeCamaraMonitorFetch(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    for (const [part, body] of Object.entries(overrides)) {
      if (!url.includes(part)) continue;
      if (isStatus(body)) return new Response(JSON.stringify(body), { status: body.status });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    }
    const u = new URL(url);
    const p = u.pathname;
    const q = u.searchParams;
    const ok = (body: string) => new Response(body, { status: 200 });
    if (p.startsWith("/arquivos/")) {
      const m = /\/arquivos\/(\w+)\/csv\/\1-(\d{4})\.csv$/.exec(p);
      return m && m[2] === "2026" ? ok(monitorFixture(`${m[1]}-2026.excerpt.csv`)) : new Response("", { status: 404 });
    }
    if (p === "/api/v2/deputados" && q.has("dataInicio")) {
      return ok(monitorFixture(q.get("pagina") === "2" ? "deputados-2026-p2.recorded.json" : "deputados-2026.recorded.json"));
    }
    if (p === "/api/v2/deputados") return ok(monitorFixture("deputados-em-exercicio.recorded.json"));
    if (p === "/api/v2/deputados/204407/discursos") return ok(monitorFixture("discursos-204407.recorded.json"));
    if (/^\/api\/v2\/deputados\/\d+\/discursos$/.test(p)) return ok(JSON.stringify({ dados: [], links: [] }));
    const sub = /^\/api\/v2\/deputados\/(\d+)\/(historico|profissoes|mandatosExternos|frentes|orgaos)$/.exec(p);
    if (sub) return ok(RECORDED.has(`${sub[2]}-${sub[1]}`) ? monitorFixture(`${sub[2]}-${sub[1]}.recorded.json`) : JSON.stringify({ dados: [], links: [] }));
    if (p === "/api/v2/blocos" && q.get("idLegislatura") === "57") return ok(monitorFixture("blocos-57.recorded.json"));
    const bloc = /^\/api\/v2\/blocos\/(58[4-9]|590)\/partidos$/.exec(p);
    if (bloc) return ok(monitorFixture(`blocos-${bloc[1]}-partidos.recorded.json`));
    if (p === "/api/v2/eventos/82635") return ok(monitorFixture("evento-82635.recorded.json"));
    if (p === "/api/v2/proposicoes/2462009") return ok(monitorFixture("proposicao-2462009.recorded.json"));
    // PL 4700/2025, the main bill of the bills excerpt's EMC-A 2 (2652548, `ano` 0); recorded 2026-11-16.
    if (p === "/api/v2/proposicoes/2563226") return ok(monitorFixture("proposicao-2563226.recorded.json"));
    if (p === "/api/v2/proposicoes" && q.get("siglaTipo") === "PL" && q.get("ano") === "2024") {
      const n = q.get("numero");
      if (n === "3880" || n === "2942") return ok(monitorFixture(`proposicoes-PL-${n}-2024.recorded.json`));
      return ok(JSON.stringify({ dados: [], links: [] }));
    }
    return new Response(JSON.stringify({ status: 404 }), { status: 404 });
  }) as typeof fetch;
  return { f, calls, json };
}
