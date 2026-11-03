import { parseRecordRef, type RecordRef } from "@digestor/core";
import { errorResponse } from "./http";
import { t } from "./i18n";

/** The optional "Official record" field of an upload: no ref when blank, an error response for one that isn't a Senado ref (a Câmara ref isn't supported yet). */
export function readRecordInput(raw: string | null | undefined): { ref: RecordRef | null } | { error: Response } {
  const text = raw?.trim();
  if (!text) return { ref: null };
  const ref = parseRecordRef(text);
  if (!ref) return { error: errorResponse(400, t("record.invalid")) };
  if (ref.chamber === "camara") return { error: errorResponse(422, t("record.camaraUnsupported")) };
  return { ref };
}
