import type { TranslatedBriefingContent } from "@digestor/core";
import { t } from "./i18n";

export type Translation =
  | { status: "pending" }
  | { status: "ready"; content: TranslatedBriefingContent }
  | { status: "failed"; error: string };

function asTranslated(content: unknown): TranslatedBriefingContent | null {
  const c = content as Partial<TranslatedBriefingContent> | null | undefined;
  return c && Array.isArray(c.lead) && Array.isArray(c.sections) ? (c as TranslatedBriefingContent) : null;
}

/**
 * The reader's translation state after an API answer.
 * - `request` (our POST): 200 ready, 202 pending; any error is the API's own sentence.
 * - `poll` (GET while pending): server trouble (5xx) keeps polling; only a stored `failed` row, or a 404 (the row we
 *   asked for is gone), ends it as failed.
 */
export function translationFromResponse(from: "request" | "poll", status: number, body: unknown): Translation {
  const b = (body ?? {}) as { status?: unknown; content?: unknown; error?: unknown };
  const apiError = typeof b.error === "string" && b.error.trim() ? b.error : null;
  const generic = t("preview.translationFailed");
  if (status < 200 || status >= 300) {
    if (from === "poll") return status >= 500 ? { status: "pending" } : { status: "failed", error: generic };
    return { status: "failed", error: apiError ?? generic };
  }
  if (b.status === "pending") return { status: "pending" };
  if (b.status === "failed") return { status: "failed", error: apiError ?? generic };
  const content = b.status === "ready" ? asTranslated(b.content) : null;
  return content ? { status: "ready", content } : { status: "failed", error: generic };
}
