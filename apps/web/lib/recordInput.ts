import { CHAMBER_IDS, parseRecordRef, recordInputError, type ChamberId, type RecordRef } from "@digestor/core";
import { errorResponse } from "./http";
import { t } from "./i18n";

/** The optional `chamber` next to a record: absent (also blank or null) means "detect from the link"; anything but one of the five ids is an error. */
export function readChamberInput(raw: unknown): { chamber: ChamberId | undefined } | { error: Response } {
  if (raw === undefined || raw === null || raw === "") return { chamber: undefined };
  if (typeof raw === "string" && (CHAMBER_IDS as string[]).includes(raw)) return { chamber: raw as ChamberId };
  return { error: errorResponse(400, t("record.invalid")) };
}

/** The optional "Official record" field of an upload: no ref when blank, an error response for text that is no record of the house (or no house when it is a link). */
export function readRecordInput(raw: string | null | undefined, chamber?: unknown): { ref: RecordRef | null } | { error: Response } {
  const house = readChamberInput(chamber);
  if ("error" in house) return house;
  const text = raw?.trim();
  if (!text) return { ref: null };
  const friendly = recordInputError(text, house.chamber);
  if (friendly) return { error: errorResponse(400, friendly) };
  const ref = parseRecordRef(text, house.chamber);
  if (!ref) return { error: errorResponse(400, t("record.invalid")) };
  return { ref };
}
