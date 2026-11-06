import type { SessionSummary } from "@digestor/core/server";
import { t } from "@/lib/i18n";
import { buildSteps } from "@/lib/processingSteps";

export interface SessionStatus {
  text: string;
  busy: boolean;
  tone: "normal" | "waiting" | "failed";
}

/** The stage in plain words for the home list. Never shows the raw error. */
export function sessionStatus(s: Pick<SessionSummary, "stage" | "error"> & Partial<Pick<SessionSummary, "source">>): SessionStatus {
  if (s.stage === "ready") return { text: t("home.ready"), busy: false, tone: "normal" };
  if (s.stage === "awaiting_context") return { text: t("home.waiting"), busy: false, tone: "waiting" };
  if (s.stage === "failed") return { text: t("home.failed"), busy: false, tone: "failed" };
  const running = buildSteps(s.stage, s.source ?? "upload").find((x) => x.state === "running");
  return { text: running?.label ?? t("processing.uploading"), busy: true, tone: "normal" };
}
