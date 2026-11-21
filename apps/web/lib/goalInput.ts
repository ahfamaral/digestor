import { errorResponse } from "./http";
import { t } from "./i18n";

/** The longest upload goal ("What do you want from this video?"): the same cap as an Ask question. Client-safe. */
export const GOAL_MAX_CHARS = 500;

/** The optional upload goal, trimmed: null when blank, an error response when it is longer than `GOAL_MAX_CHARS`. */
export function readGoalInput(raw: string | null | undefined): { goal: string | null } | { error: Response } {
  const goal = raw?.trim() || null;
  if (goal && goal.length > GOAL_MAX_CHARS) return { error: errorResponse(400, t("upload.goalTooLong")) };
  return { goal };
}
