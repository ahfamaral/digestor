/** Leaf module: the record connector types and errors. Imports no connector, so the connectors and the registry can all import it. */
import { CHAMBERS, recordRefDate, type ChamberId, type RecordRef } from "@digestor/core";

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

/** Deterministic: the house hasn't published this record yet; the run waits and tries again later. */
export class RecordNotPublishedError extends Error {
  constructor(message = "The record has not been published yet.") {
    super(message);
    this.name = "RecordNotPublishedError";
  }
}


const DAY_MS = 86_400_000;
const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);

/**
 * "The record isn't there": `RecordNotPublishedError` while the sitting is still inside the house's publish window
 * (whole UTC days since `date`, or since `linkedAt` for a ref without a date, at most `publishWindowDays`), else
 * `RecordNotFoundError(notFoundMessage)`.
 */
export function notPublishedOrNotFound(chamber: ChamberId, date: string | null, now: Date, notFoundMessage: string, linkedAt?: Date): RecordNotPublishedError | RecordNotFoundError {
  const from = date ? new Date(`${date}T00:00:00Z`) : linkedAt;
  if (!from || Number.isNaN(from.getTime())) return new RecordNotFoundError(notFoundMessage);
  return utcDay(now) - utcDay(from) <= CHAMBERS[chamber].publishWindowDays ? new RecordNotPublishedError() : new RecordNotFoundError(notFoundMessage);
}

/** Whether the ref's sitting is still inside its house's publish window (the same rule as `notPublishedOrNotFound`). */
export function insidePublishWindow(ref: RecordRef, now: Date, linkedAt: Date): boolean {
  return notPublishedOrNotFound(ref.chamber, "date" in ref ? ref.date : null, now, "", linkedAt) instanceof RecordNotPublishedError;
}

/** The line a waiting row shows (stored in `session_records.error`). */
export function waitingLine(ref: RecordRef): string {
  const date = recordRefDate(ref);
  const of = date ? `of ${date}` : "sitting" in ref && ref.sitting ? `of sitting ${ref.sitting}` : "of that sitting";
  return `The ${CHAMBERS[ref.chamber].shortName} hasn't published the record ${of} yet. Digestor will check again. If there was no sitting that day, check the date.`;
}

/** The line a row shows while it waits after a fetch that kept failing (an outage, not a missing record). */
export function fetchRetryLine(ref: RecordRef): string {
  return `The ${CHAMBERS[ref.chamber].shortName} record couldn't be fetched just now. Digestor will try again.`;
}
