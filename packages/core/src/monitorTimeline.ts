// Parliament monitor: a deputy's party history and profile as published by the Câmara (client-safe, no DB).

/** A row of `/deputados/{id}/historico`: `at` is Brasília local time "YYYY-MM-DDTHH:MM"; `status` is `situacao`. */
export type HistoryRow = { at: string; party: string | null; uf: string | null; status: string | null; description: string };
/** An earlier mandate (`/mandatosExternos`), consecutive terms merged: "Vereador(a) · Porto Alegre (RS) · 2009–2018". */
export type ExternalMandate = { office: string; place: string; uf: string | null; from: number; to: number | null; party: string | null };
/** A seat in a body (`/orgaos`): `title` as published ("Titular", "Presidente"…); days. */
export type Position = { body: string; bodyName: string; title: string; from: string; to: string | null };

/** A stretch of the legislature with one party and one in-office state; days, `to` null = still so today. */
export type TimelineBand = { party: string | null; uf: string | null; from: string; to: string | null; inOffice: boolean; description: string };

/** In office ⇔ the history row's `situacao` is "Exercício". */
const IN_OFFICE = "Exercício";

/**
 * The history as bands: a new band starts when the party or the in-office state changes; an out-of-office band carries
 * the description of the row that started it (leave, ministry, end of mandate). Rows on the same day as the band they
 * would close replace it (the legislature's first rows are a name row and the swearing-in, minutes apart). Bands before
 * `since` are dropped or clipped to it.
 */
export function partyTimeline(rows: HistoryRow[], since = "2023-02-01"): TimelineBand[] {
  const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const bands: TimelineBand[] = [];
  for (const r of sorted) {
    const day = r.at.slice(0, 10);
    const inOffice = r.status === IN_OFFICE;
    const last = bands.at(-1);
    if (last && last.party === r.party && last.inOffice === inOffice) continue;
    const band = { party: r.party, uf: r.uf, from: day, to: null, inOffice, description: inOffice ? "" : r.description };
    if (last && last.from === day) {
      bands[bands.length - 1] = band;
      const prev = bands.at(-2);
      if (prev && prev.party === band.party && prev.inOffice === band.inOffice) {
        bands.pop();
        prev.to = null;
      }
      continue;
    }
    if (last) last.to = day;
    bands.push(band);
  }
  return bands.filter((b) => b.to === null || b.to > since).map((b) => (b.from < since ? { ...b, from: since } : b));
}

/** The in-office stretches of a timeline, adjacent bands (a party change) joined. */
export function inOfficePeriods(bands: TimelineBand[]): { from: string; to: string | null }[] {
  const out: { from: string; to: string | null }[] = [];
  for (const b of bands) {
    if (!b.inOffice) continue;
    const last = out.at(-1);
    if (last && last.to === b.from) last.to = b.to;
    else out.push({ from: b.from, to: b.to });
  }
  return out;
}
