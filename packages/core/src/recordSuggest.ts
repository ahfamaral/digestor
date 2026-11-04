import { CHAMBERS, CHAMBER_IDS, type ChamberId } from "./chambers.ts";
import { BUNDESTAG_URL, bundestagPeriod, dayRef, senadoDayUrl, validDate, type RecordRef } from "./recordRef.ts";

/** What the worker knows of a YouTube video (a subset of its metadata). */
export type VideoDetails = { title: string; description: string; channel: string; uploadDate: string | null };

/** Lower-case, accent-free: the registry's patterns are written for this form. */
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const MONTHS: Record<"pt" | "de" | "en", string[]> = {
  pt: ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
  de: ["januar", "februar", "marz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"],
  en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
};
const monthNo = (lang: keyof typeof MONTHS, name: string) => {
  const n = name === "maerz" ? "marz" : name;
  const i = MONTHS[lang].indexOf(n);
  return i < 0 ? null : i + 1;
};
const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** All valid dates in the text, in reading order, as `YYYY-MM-DD`. `us` reads `11/4/2026` as month first. */
function datesIn(text: string, lang: keyof typeof MONTHS, us: boolean): string[] {
  const found: { at: number; date: string }[] = [];
  const add = (at: number, y: number, m: number | null, d: number) => {
    const date = m === null || y < 2000 ? null : validDate(y, m, d);
    if (date) found.push({ at, date });
  };
  for (const x of text.matchAll(/(?<!\d)(\d{1,2})º?[/.](\d{1,2})[/.](\d{4}|\d{2})(?!\d)/g)) {
    const [a, b] = [Number(x[1]), Number(x[2])];
    add(x.index, year(x[3]!), us ? a : b, us ? b : a);
  }
  if (lang === "en") {
    for (const x of text.matchAll(/\b([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/g)) add(x.index, Number(x[3]), monthNo("en", x[1]!), Number(x[2]));
  } else if (lang === "de") {
    for (const x of text.matchAll(/(?<!\d)(\d{1,2})\. ([a-z]+) (\d{4})\b/g)) add(x.index, Number(x[3]), monthNo("de", x[2]!), Number(x[1]));
  } else {
    for (const x of text.matchAll(/(?<!\d)(\d{1,2})º? de ([a-z]+) de (\d{4})\b/g)) add(x.index, Number(x[3]), monthNo("pt", x[2]!), Number(x[1]));
  }
  return found.sort((p, q) => p.at - q.at).map((f) => f.date);
}

/** "103. Sitzung", "103. Plenarsitzung". */
function sittingIn(text: string): number | null {
  const x = /(?<!\d)(\d{1,3})\. (?:plenar)?sitzung\b/.exec(text);
  return x && Number(x[1]) > 0 ? Number(x[1]) : null;
}

const LANG: Record<ChamberId, keyof typeof MONTHS> = { camara: "pt", senado: "pt", bundestag: "de", us_house: "en", us_senate: "en" };

/** The one house the channel and words point at; null when none, or when two are equally likely. */
function houseOf(channel: string, text: string): ChamberId | null {
  const own = CHAMBER_IDS.filter((id) => CHAMBERS[id].suggest.ownChannels.some((p) => p.test(channel)));
  if (own.length) return own.length === 1 ? own[0]! : null;
  const viaBroadcaster = CHAMBER_IDS.filter((id) => {
    const s = CHAMBERS[id].suggest;
    return s.broadcasterChannels.some((p) => p.test(channel)) && s.sittingWords.some((p) => p.test(text));
  });
  return viaBroadcaster.length === 1 ? viaBroadcaster[0]! : null;
}

/** `YYYY-MM-DD` from yt-dlp's `uploadDate` (also accepts `YYYYMMDD`). */
function isoUpload(d: string | null): string | null {
  const x = d && /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(d);
  return x ? validDate(Number(x[1]), Number(x[2]), Number(x[3])) : null;
}

function refFor(chamber: ChamberId, date: string | null, sitting: number | null): RecordRef | null {
  switch (chamber) {
    case "senado":
      return date ? { chamber, date, sessionCode: null, url: senadoDayUrl(date) } : null;
    case "camara":
    case "us_house":
    case "us_senate":
      return date ? dayRef(chamber, date) : null;
    case "bundestag": {
      const period = date ? bundestagPeriod(date) : null;
      if (date) return period === null ? null : { chamber, period, sitting, date, url: BUNDESTAG_URL };
      return sitting === null ? null : { chamber, period: 21, sitting, date: null, url: BUNDESTAG_URL };
    }
  }
}

/**
 * Which sitting a YouTube video belongs to, from its details alone (spec 6.3, no LLM). A suggestion needs a house and a
 * date or sitting number. The house comes from the parliament's own channel, or from a broadcaster plus a sitting word;
 * the date or number from the title, then the description; `uploadDate` only on an own channel, as the last resort.
 */
export function suggestRecord(meta: VideoDetails): RecordRef | null {
  const channel = norm(meta.channel);
  const title = norm(meta.title);
  const description = norm(meta.description);
  const chamber = houseOf(channel, `${title}\n${description}`);
  if (!chamber) return null;
  const own = CHAMBERS[chamber].suggest.ownChannels.some((p) => p.test(channel));
  const us = chamber === "us_house" || chamber === "us_senate";
  for (const text of [title, description]) {
    const date = datesIn(text, LANG[chamber], us)[0] ?? null;
    const sitting = chamber === "bundestag" ? sittingIn(text) : null;
    if (date === null && sitting === null) continue;
    // A sitting number with no date never falls back to the upload date: it names a sitting the date may not fit.
    if (date === null) return sittingOnly(chamber, sitting!, meta.uploadDate);
    const ref = refFor(chamber, date, sitting);
    if (ref) return ref;
  }
  if (!own) return null;
  const upload = isoUpload(meta.uploadDate);
  return upload ? refFor(chamber, upload, null) : null;
}

/** A sitting number with no date: the current period (21), and only when the upload date lies in it. */
function sittingOnly(chamber: ChamberId, sitting: number, uploadDate: string | null): RecordRef | null {
  const upload = isoUpload(uploadDate);
  return chamber === "bundestag" && upload && bundestagPeriod(upload) === 21 ? refFor(chamber, null, sitting) : null;
}
