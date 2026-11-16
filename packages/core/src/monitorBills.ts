// Câmara bill labels; client-safe (no pg / fs).

/**
 * "PL 1761/2025". An item numbered inside its main bill (an opinion, substitute or amendment: PRL, SBR, EMC…) has
 * year 0 in the Câmara's data and is labelled without it: "PRL 1", never "PRL 1/0".
 */
export function billLabel(type: string, number: number, year: number): string {
  return year > 0 ? `${type} ${number}/${year}` : `${type} ${number}`;
}

/** The id at the end of a Câmara API link (".../api/v2/proposicoes/2636921" → 2636921), or null. */
export function idFromUri(uri: string | null | undefined): number | null {
  const m = /\/(\d+)\/?$/.exec(uri?.trim() ?? "");
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
