import { readFileSync } from "node:fs";

/**
 * Test fake of the GovInfo Congressional Record routes (https://api.govinfo.gov, key in the `X-Api-Key` header; the fake answers 403 without one, as api.data.gov does for an invalid key), recorded 2026-11-04
 * with the public DEMO_KEY (the key is stripped from everything stored; vendor-contract-check):
 *  - GET /packages/CREC-2026-11-02/granules?pageSize=1000&offsetMark=*  -> crec-2026-11-02-granules.json (68 granules:
 *    HOUSE 15, SENATE 4, EXTENSIONS 43, DAILYDIGEST 6; a pro forma day, so the speeches are thin; `nextPage` null)
 *  - GET /packages/CREC-2024-05-01/granules/CREC-2024-05-01-pt1-PgH2790/htm  -> crec-2024-05-01-pt1-PgH2790.htm (58 KB `<pre>`)
 *    and `/mods` -> crec-2024-05-01-pt1-PgH2790.mods.xml (23 KB, 15 `congMember`s, incl. "Mr. SMITH of New Jersey").
 *    The 2024 day is the one the research verified; its granule list was NOT recorded (DEMO_KEY allows about 10 calls),
 *    so the fake serves it under a hand-made one-entry list for 2024-05-01.
 *  - GET .../CREC-2026-11-02/granules/CREC-2026-11-02-pt1-PgS5333/htm and `/mods` -> crec-2026-11-02-pt1-PgS5333.* (the
 *    Senate's pro forma opening: no speaker label, MODS without any `congMember`).
 *  - A package that does not exist (CREC-2026-11-04, the day recorded) answers 200 with `{"count":0,"granules":[]}`, NOT 404
 *    (recorded). The 404 the plan expected is kept as an option for a granule/package that the server does remove.
 * UNVERIFIED (to smoke.md): Senate htm/mods of a real debate day (labels "Mr. THUNE.", "The PRESIDING OFFICER (Mr. LEE).",
 * congMember chamber="S"); granule 404; 429 body; pagination (`nextPage`) of a package over 1000 granules.
 */
const fx = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8");
export const GRANULES_2026_11_02 = JSON.parse(fx("crec-2026-11-02-granules.json")) as { granules: Granule[] };
export const HOUSE_HTM = fx("crec-2024-05-01-pt1-PgH2790.htm");
export const HOUSE_MODS = fx("crec-2024-05-01-pt1-PgH2790.mods.xml");
export const SENATE_HTM = fx("crec-2026-11-02-pt1-PgS5333.htm");
export const SENATE_MODS = fx("crec-2026-11-02-pt1-PgS5333.mods.xml");
export const HOUSE_GRANULE_2024 = "CREC-2024-05-01-pt1-PgH2790";
export const SENATE_GRANULE_2026 = "CREC-2026-11-02-pt1-PgS5333";

export type Granule = { dateIssued?: string; granuleClass: string; granuleId: string; granuleLink?: string; title: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type FakeUsCongressOptions = {
  /** Replaces the list answer for a package (`CREC-YYYY-MM-DD`). */
  list?: (pkg: string, url: URL) => Response | Promise<Response>;
  /** Replaces the htm/mods answer of a granule. */
  granule?: (granuleId: string, kind: "htm" | "mods") => Response | Promise<Response>;
};

/** A minimal htm with no speaker label, for a granule the fixtures don't hold. SYNTHETIC. */
export const stubHtm = (granuleId: string) => `<html>\n<head>\n<title>Congressional Record</title>\n</head>\n<body><pre>\n[Congressional Record]\n[House]\nFrom the Congressional Record Online through the Government Publishing Office [<a href="https://www.gpo.gov">www.gpo.gov</a>]\n\n  Stub text of ${granuleId}.\n</pre></body>\n</html>`;

/** A `fetch` answering the GovInfo routes from the fixtures; `calls` records every URL (never with the key) and `keys` each request's X-Api-Key. */
export function fakeUsCongressFetch(o: FakeUsCongressOptions = {}) {
  const calls: string[] = [];
  const keys: (string | null)[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    keys.push(new Headers(init?.headers).get("x-api-key"));
    const u = new URL(url);
    const m = /^\/packages\/(CREC-\d{4}-\d{2}-\d{2})(?:\/granules(?:\/([^/]+)\/(htm|mods))?)?$/.exec(u.pathname);
    if (u.hostname !== "api.govinfo.gov" || !m || !new Headers(init?.headers).get("x-api-key") || u.searchParams.has("api_key")) return json({ error: "API_KEY_MISSING" }, 403);
    const [, pkg, gid, kind] = m as unknown as [string, string, string | undefined, "htm" | "mods" | undefined];
    if (!gid) {
      if (o.list) return o.list(pkg, u);
      if (pkg === "CREC-2026-11-02") return json({ ...GRANULES_2026_11_02, count: GRANULES_2026_11_02.granules.length, nextPage: null });
      if (pkg === "CREC-2024-05-01") return json({ count: 1, offset: null, pageSize: 1000, nextPage: null, previousPage: null, granules: [{ dateIssued: "2024-05-01", granuleClass: "HOUSE", granuleId: HOUSE_GRANULE_2024, title: "ANTISEMITISM AWARENESS ACT OF 2023" }] });
      return json({ count: 0, offset: null, pageSize: 1000, nextPage: null, previousPage: null, granules: [] });
    }
    if (o.granule) return o.granule(gid, kind!);
    const body = gid === HOUSE_GRANULE_2024 ? (kind === "htm" ? HOUSE_HTM : HOUSE_MODS) : gid === SENATE_GRANULE_2026 ? (kind === "htm" ? SENATE_HTM : SENATE_MODS) : null;
    if (body === null) return kind === "htm" ? new Response(stubHtm(gid), { status: 200, headers: { "content-type": "text/html" } }) : new Response("<mods/>", { status: 200, headers: { "content-type": "application/xml" } });
    return new Response(body, { status: 200, headers: { "content-type": kind === "htm" ? "text/html" : "application/xml" } });
  }) as typeof fetch;
  return { f, calls, keys };
}
