/**
 * A link to the official record of a session (Task 15). URL shapes confirmed live on 2026-11-03:
 *  - Senado plenary session page: `https://www25.senado.leg.br/web/atividade/plenario/-/sessao/<CodigoSessao>` (200).
 *    The page is rendered in the browser and its URL carries no date, and the open-data API has no lookup by
 *    session code (the speeches list is by day, at most one month), so a Senado link also needs the date,
 *    written next to it (`2025-10-21` or `21/10/2025`). Without one it is not accepted.
 *  - A plain date (`2025-10-21`, `21/10/2025`) means the Senado speeches of that day.
 *  - Câmara event page: `https://www.camara.leg.br/evento-legislativo/<id>` (200; a missing id answers 500).
 * The `/web/atividade/sessoes-plenarias/...` shape seen in some links answers 404, so it is not accepted.
 */
export type RecordRef =
  | { chamber: "senado"; date: string; sessionCode: string | null; url: string }
  | { chamber: "camara"; eventId: string; url: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BR_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` or `DD/MM/YYYY` as `YYYY-MM-DD`, null for anything else (or a day that doesn't exist). */
function parseDate(token: string): string | null {
  const iso = ISO_DATE.exec(token);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const br = BR_DATE.exec(token);
  if (br) return validDate(Number(br[3]), Number(br[2]), Number(br[1]));
  return null;
}

const SENADO_HOSTS = new Set(["senado.leg.br", "www.senado.leg.br", "www25.senado.leg.br"]);
const CAMARA_HOSTS = new Set(["camara.leg.br", "www.camara.leg.br"]);

export function senadoDayUrl(date: string): string {
  const day = date.replaceAll("-", "");
  return `https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/${day}/${day}`;
}

export function parseRecordRef(input: string): RecordRef | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return null;
  let date: string | null = null;
  let link: URL | null = null;
  for (const token of tokens) {
    const d = parseDate(token);
    if (d) {
      if (date) return null;
      date = d;
      continue;
    }
    if (link) return null;
    try {
      link = new URL(/^[a-z]+:\/\//i.test(token) ? token : `https://${token}`);
    } catch {
      return null;
    }
    if (link.protocol !== "https:" && link.protocol !== "http:") return null;
  }
  if (!link) return date ? { chamber: "senado", date, sessionCode: null, url: senadoDayUrl(date) } : null;
  const path = link.pathname.replace(/\/+$/, "");
  const host = link.hostname.toLowerCase();
  if (SENADO_HOSTS.has(host)) {
    const m = /^\/web\/atividade\/plenario\/-\/sessao\/(\d+)$/.exec(path);
    if (!m || !date) return null;
    return { chamber: "senado", date, sessionCode: m[1]!, url: `https://www25.senado.leg.br/web/atividade/plenario/-/sessao/${m[1]}` };
  }
  if (CAMARA_HOSTS.has(host) && !date) {
    const m = /^\/evento-legislativo\/(\d+)$/.exec(path);
    if (!m) return null;
    return { chamber: "camara", eventId: m[1]!, url: `https://www.camara.leg.br/evento-legislativo/${m[1]}` };
  }
  return null;
}

/** The Senado ref's date as the journalist reads it (`DD/MM/YYYY`) for the status line; null for a Câmara ref. */
export function recordRefDate(ref: RecordRef): string | null {
  if (ref.chamber !== "senado") return null;
  const [y, m, d] = ref.date.split("-");
  return `${d}/${m}/${y}`;
}

/** Where a linked record stands: `pending` (linked, not fetched), `running`, `matched`, `failed` (with a friendly `error`). */
export type RecordStatus = "pending" | "running" | "matched" | "failed";
