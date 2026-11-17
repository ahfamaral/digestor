import { errorResponse } from "./http";
import { t } from "./i18n";

/** The longest upload note ("Anything we should know?"): it goes into every context-check prompt. Client-safe. */
export const HINT_MAX_CHARS = 2000;

/** The optional upload note, trimmed: null when blank, an error response when it is longer than `HINT_MAX_CHARS`. */
export function readHintInput(raw: string | null | undefined): { hint: string | null } | { error: Response } {
  const hint = raw?.trim() || null;
  if (hint && hint.length > HINT_MAX_CHARS) return { error: errorResponse(400, t("upload.hintTooLong")) };
  return { hint };
}
