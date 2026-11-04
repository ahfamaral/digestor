import type { ChamberId, RecordRef } from "@digestor/core";
import { camaraConnector } from "./camara.js";
import { senadoConnector } from "./senado.js";

/** One speech of an official record, whatever the house. `officialId` is null when the record doesn't say who spoke (it still takes part in the alignment, but names no one). */
export interface RecordSpeech {
  id: string;
  order: number;
  officialId: string | null;
  name: string;
  party: string | null;
  state: string | null;
  text: string;
  /** The Câmara's stamp (`YYYY-MM-DDTHH:MM`, a 4-minute stenography block): speeches sharing it have no known order. Senado leaves it unset. */
  at?: string;
  /** "summary" when the full text was missing (404) and `text` is the API's short `Resumo`. */
  textSource: "full" | "summary";
}

/** What a house's record says about a member, by official id; fills the person row. */
export type MemberInfo = { displayName: string; fullName?: string | null; party?: string | null; state?: string | null; photoUrl?: string | null };

export interface RecordConnector {
  chamber: ChamberId;
  /** `url` is set when the connector resolved a better record URL than the ref's. `date` is `YYYY-MM-DD`. */
  fetchRecord(
    ref: RecordRef,
    f: typeof fetch,
    ctx: { now: Date; linkedAt: Date },
  ): Promise<{ speeches: RecordSpeech[]; date: string; url?: string; members: Record<string, MemberInfo> }>;
  /** The speech as its own speaker said it (what is compared with the transcript). */
  speechText(speech: RecordSpeech): string;
  stopWords: ReadonlySet<string>;
}

/** Deterministic: the record has nothing for this day, session or senator. */
export class RecordNotFoundError extends Error {
  constructor(message = "The Senado has no speeches for that date.") {
    super(message);
    this.name = "RecordNotFoundError";
  }
}

/** Deterministic: the house hasn't published this record yet (used from Task 6). */
export class RecordNotPublishedError extends Error {
  constructor(message = "The record has not been published yet.") {
    super(message);
    this.name = "RecordNotPublishedError";
  }
}

/** The connector of a house, or null while the house has none. Looked up per call (the Brazilian modules import this one). */
export function findConnector(chamber: ChamberId): RecordConnector | null {
  switch (chamber) {
    case "senado": return senadoConnector;
    case "camara": return camaraConnector;
    default: return null;
  }
}

export function connectorFor(chamber: ChamberId): RecordConnector {
  const c = findConnector(chamber);
  if (!c) throw new Error(`No record connector for ${chamber} yet.`);
  return c;
}
