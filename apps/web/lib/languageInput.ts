import { LANGUAGE_PICK_ERROR, isSpokenLanguageCode } from "@digestor/core";
import { errorResponse } from "@/lib/http";

/** The optional spoken-language override of an upload: missing or empty means "detect automatically" (null). */
export function readLanguageInput(value: unknown): { code: string | null } | { error: Response } {
  if (value === undefined || value === null || value === "") return { code: null };
  if (isSpokenLanguageCode(value)) return { code: value };
  return { error: errorResponse(400, LANGUAGE_PICK_ERROR) };
}

export const START_FAILED = "We couldn't start processing. Please try again.";
