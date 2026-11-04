/** The houses Digestor can match against an official record (Plan 4). Pure data, client-safe. */
export type ChamberId = "camara" | "senado" | "bundestag" | "us_house" | "us_senate";
export type IdSystem = "camara" | "senado" | "bundestag" | "bioguide";

export type Chamber = {
  id: ChamberId;
  country: "BR" | "DE" | "US";
  countryName: "Brazil" | "Germany" | "USA";
  name: string;
  shortName: string;
  idSystem: IdSystem;
  defaultLanguage: "pt" | "de" | "en";
  /** Days after a sitting the house usually needs to publish its record. */
  publishWindowDays: number;
  /** Leading titles that are no part of the name an official is known by (lower-case matching, no trailing dot). */
  titles: string[];
  /** A house whose name matching has been measured against a golden set; others only propose names. */
  evaluated: boolean;
  thresholds: { confirm: number; propose: number };
};

const BR_TITLES = ["senador", "senadora", "sen", "deputado", "deputada", "dep", "presidente", "ministro", "ministra", "doutor", "doutora", "dr", "dra", "sr", "sra", "o", "a"];
const US_TITLES = ["Mr.", "Mrs.", "Ms.", "Miss", "Rep.", "Representative", "Sen.", "Senator", "Speaker"];
const THRESHOLDS = { confirm: 0.6, propose: 0.35 };

export const CHAMBERS: Record<ChamberId, Chamber> = {
  camara: {
    id: "camara", country: "BR", countryName: "Brazil", name: "Câmara dos Deputados", shortName: "Câmara",
    idSystem: "camara", defaultLanguage: "pt", publishWindowDays: 2, titles: BR_TITLES, evaluated: true, thresholds: THRESHOLDS,
  },
  senado: {
    id: "senado", country: "BR", countryName: "Brazil", name: "Senado Federal", shortName: "Senado",
    idSystem: "senado", defaultLanguage: "pt", publishWindowDays: 2, titles: BR_TITLES, evaluated: true, thresholds: THRESHOLDS,
  },
  bundestag: {
    id: "bundestag", country: "DE", countryName: "Germany", name: "Deutscher Bundestag", shortName: "Bundestag",
    idSystem: "bundestag", defaultLanguage: "de", publishWindowDays: 21,
    titles: ["Abg.", "Präsident", "Präsidentin", "Vizepräsident", "Vizepräsidentin", "Bundesminister", "Bundesministerin", "Bundeskanzler", "Bundeskanzlerin", "Staatssekretär", "Staatssekretärin", "Dr."],
    evaluated: false, thresholds: THRESHOLDS,
  },
  us_house: {
    id: "us_house", country: "US", countryName: "USA", name: "U.S. House of Representatives", shortName: "House",
    idSystem: "bioguide", defaultLanguage: "en", publishWindowDays: 3, titles: US_TITLES, evaluated: false, thresholds: THRESHOLDS,
  },
  us_senate: {
    id: "us_senate", country: "US", countryName: "USA", name: "U.S. Senate", shortName: "Senate",
    idSystem: "bioguide", defaultLanguage: "en", publishWindowDays: 3, titles: US_TITLES, evaluated: false, thresholds: THRESHOLDS,
  },
};

export const CHAMBER_IDS: ChamberId[] = ["camara", "senado", "bundestag", "us_house", "us_senate"];

/** Confirm is Infinity for a house that is not evaluated: its names are proposals only. */
export function chamberThresholds(id: ChamberId): { confirm: number; propose: number } {
  const c = CHAMBERS[id];
  return c.evaluated ? { ...c.thresholds } : { confirm: Infinity, propose: c.thresholds.propose };
}

/** "Senado", "Bundestag (Germany)", "House (USA)". */
export function chamberLabel(id: ChamberId): string {
  const c = CHAMBERS[id];
  return c.country === "BR" ? c.shortName : `${c.shortName} (${c.countryName})`;
}
