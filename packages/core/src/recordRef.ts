import type { ChamberId } from "./chambers.ts";

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
  | { chamber: "camara"; eventId: string; url: string }
  | { chamber: "camara"; date: string; url: string }
  | { chamber: "bundestag"; period: number; sitting: number | null; date: string | null; url: string }
  | { chamber: "us_house" | "us_senate"; date: string; url: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` or `DD/MM/YYYY` (`MM/DD/YYYY` when `us`) as `YYYY-MM-DD`, null for anything else (or a day that doesn't exist). */
function parseDate(token: string, us = false): string | null {
  const iso = ISO_DATE.exec(token);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const br = SLASH_DATE.exec(token);
  if (br) return us ? validDate(Number(br[3]), Number(br[1]), Number(br[2])) : validDate(Number(br[3]), Number(br[2]), Number(br[1]));
  return null;
}

const SENADO_HOSTS = new Set(["senado.leg.br", "www.senado.leg.br", "www25.senado.leg.br"]);
const CAMARA_HOSTS = new Set(["camara.leg.br", "www.camara.leg.br"]);

/** Until the connector resolves the protocol XML of a sitting. */
export const BUNDESTAG_URL = "https://www.bundestag.de/services/opendata";

export function senadoDayUrl(date: string): string {
  const day = date.replaceAll("-", "");
  return `https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/${day}/${day}`;
}

/** Bundestag electoral periods by the day they start (inclusive); the latest one is open-ended. */
const BUNDESTAG_PERIODS: { period: number; from: string }[] = [
  { period: 21, from: "2025-03-25" },
  { period: 20, from: "2021-10-26" },
  { period: 19, from: "2017-10-24" },
];

export function bundestagPeriod(date: string): number | null {
  return BUNDESTAG_PERIODS.find((p) => date >= p.from)?.period ?? null;
}

const ddmmyyyy = (date: string) => date.split("-").reverse().join("/");

export function dayRef(chamber: "camara" | "us_house" | "us_senate", date: string): RecordRef {
  if (chamber === "camara") {
    const d = ddmmyyyy(date);
    return { chamber, date, url: `https://www.camara.leg.br/agenda?dataInicial=${d}&dataFinal=${d}` };
  }
  const [y, m, d] = date.split("-");
  return { chamber, date, url: `https://www.congress.gov/congressional-record/${y}/${m}/${d}/${chamber === "us_house" ? "house" : "senate"}-section` };
}

/** `chamber` is the house the journalist picked; it reads a bare date or number, while a link always decides its own house. */
export function parseRecordRef(input: string, chamber?: ChamberId): RecordRef | null {
  const us = chamber === "us_house" || chamber === "us_senate";
  const sitting = chamber === "bundestag" ? /^(\d{1,2})\/(\d{1,3})$/.exec(input.trim()) : null;
  if (sitting && Number(sitting[1]) > 0 && Number(sitting[2]) > 0) {
    return { chamber: "bundestag", period: Number(sitting[1]), sitting: Number(sitting[2]), date: null, url: BUNDESTAG_URL };
  }
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return null;
  let dateToken: string | null = null;
  let link: URL | null = null;
  for (const token of tokens) {
    // A date token is any token parseDate accepts in either order; its order is decided once the house is known.
    if (parseDate(token) || parseDate(token, true)) {
      if (dateToken) return null;
      dateToken = token;
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
  // A link decides its own house, and every linked house is Brazilian (DD/MM/YYYY); MM/DD only on the US path.
  const date = dateToken ? parseDate(dateToken, !link && us) : null;
  if (dateToken && !date) return null;
  if (!link) {
    if (!date) return null;
    if (chamber === "camara" || us) return dayRef(chamber, date);
    if (chamber === "bundestag") {
      const period = bundestagPeriod(date);
      return period === null ? null : { chamber: "bundestag", period, sitting: null, date, url: BUNDESTAG_URL };
    }
    return { chamber: "senado", date, sessionCode: null, url: senadoDayUrl(date) };
  }
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

/** A `YYYY-MM-DD` date as the house's country reads it: `MM/DD/YYYY` for the USA, `DD/MM/YYYY` elsewhere. */
export function formatRecordDate(chamber: ChamberId, date: string): string {
  const [y, m, d] = date.split("-");
  return chamber === "us_house" || chamber === "us_senate" ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

/** The ref's date as the journalist reads it (`MM/DD/YYYY` for US houses, else `DD/MM/YYYY`); null for a ref without one. */
export function recordRefDate(ref: RecordRef): string | null {
  if (!("date" in ref) || !ref.date) return null;
  return formatRecordDate(ref.chamber, ref.date);
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

/** A friendly line for a link that is a video, not a record; null for anything else (the caller then parses it). */
export function recordInputError(input: string, _chamber?: ChamberId): string | null {
  const token = input.trim().split(/\s+/)[0] ?? "";
  if (!token) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(token) ? token : `https://${token}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return "Paste the date or the official record link.";
  if ((host === "bundestag.de" || host === "www.bundestag.de") && url.pathname.startsWith("/mediathek")) {
    return "Paste the date or sitting number instead.";
  }
  return null;
}

/** Where a linked record stands: `pending` (linked, not fetched), `running`, `matched`, `failed` (with a friendly `error`). */
export type RecordStatus = "suggested" | "pending" | "running" | "matched" | "failed" | "waiting";
