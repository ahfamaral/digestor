import { readFileSync } from "node:fs";

/**
 * Test fake of the Bundestag open-data routes, over fixtures recorded live on 2026-11-04 (vendor-contract-check):
 *  - GET https://www.bundestag.de/ajax/filterlist/de/services/opendata/1058442-1058442?limit=10&noFilterSet=true
 *    (WP21 list, page 1 = sittings 103..94; the server caps `limit` at 10) -> bundestag-filterlist-wp21.html
 *  - the same with `&offset=10` (sittings 93..84) -> bundestag-filterlist-wp21-page2.html
 *  - `&offset=2000` (past the end: a "Leider keine Ergebnisse gefunden!" template, status 200) -> bundestag-filterlist-empty.html
 *  - GET https://www.bundestag.de/resource/blob/1225450/21103.xml (sitting 103 of 16.10.2026, 454 KB), trimmed to 6 `<rede>`
 *    elements (president and vice-president lines, three ministers' ids incl. one with a title, `<kommentar>`s)
 *    -> bundestag-21103.xml
 * Each sitting appears twice in a page (a table and a list template); the server returns 10 entries per page.
 * The DIP route is NOT recorded: no key was available. Its answer is modelled on the DIP API docs
 * (https://dip.bundestag.de/documents/informationsblatt_zur_dip_api_v01.pdf): `{ numFound, documents: [{ id, dokumentnummer, datum, fundstelle: { xml_url, pdf_url } }] }`.
 */
const fx = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8");
export const FILTERLIST_PAGE1 = fx("bundestag-filterlist-wp21.html");
export const FILTERLIST_PAGE2 = fx("bundestag-filterlist-wp21-page2.html");
export const FILTERLIST_EMPTY = fx("bundestag-filterlist-empty.html");
export const PROTOKOLL_21103 = fx("bundestag-21103.xml");
export const XML_URL_21103 = "https://www.bundestag.de/resource/blob/1225450/21103.xml";
export const LISTING_URL_WP21 = "https://www.bundestag.de/ajax/filterlist/de/services/opendata/1058442-1058442";

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });

export type FakeBundestagOptions = {
  /** Replaces the listing answer (receives the `offset`). */
  listing?: (offset: number) => Response | Promise<Response>;
  /** Replaces the DIP answer. */
  dip?: (url: URL) => Response | Promise<Response>;
  /** Replaces the XML answer. */
  xml?: (url: string) => Response | Promise<Response>;
};

/** A `fetch` answering the three routes from the fixtures; `calls` records every URL. */
export function fakeBundestagFetch(o: FakeBundestagOptions = {}) {
  const calls: string[] = [];
  const dipHeaders: Record<string, string>[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.startsWith("/ajax/filterlist/de/services/opendata/")) {
      const offset = Number(u.searchParams.get("offset") ?? 0);
      if (o.listing) return o.listing(offset);
      if (!u.pathname.endsWith("1058442-1058442")) return html(FILTERLIST_EMPTY);
      return html(offset === 0 ? FILTERLIST_PAGE1 : offset === 10 ? FILTERLIST_PAGE2 : FILTERLIST_EMPTY);
    }
    if (u.hostname === "search.dip.bundestag.de") {
      dipHeaders.push((init?.headers ?? {}) as Record<string, string>);
      if (o.dip) return o.dip(u);
      // DIP takes the key in the Authorization header ("ApiKey <key>"), never in the URL.
      const ok = u.searchParams.get("f.dokumentnummer") === "21/103" && /^ApiKey \S+$/.test((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      const body = ok
        ? { numFound: 1, documents: [{ id: "300001", typ: "Dokument", dokumentart: "Plenarprotokoll", dokumentnummer: "21/103", datum: "2026-10-16", fundstelle: { xml_url: XML_URL_21103, pdf_url: "https://dserver.bundestag.de/btp/21/21103.pdf" } }] }
        : { numFound: 0, documents: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.pathname.startsWith("/resource/blob/")) {
      if (o.xml) return o.xml(url);
      return url === XML_URL_21103 ? new Response(PROTOKOLL_21103, { status: 200, headers: { "content-type": "application/xml" } }) : html("not found", 404);
    }
    return html("not found", 404);
  }) as typeof fetch;
  return { f, calls, dipHeaders };
}
