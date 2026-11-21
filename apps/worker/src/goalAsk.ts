import { getSession, startAskQuestion, type Db } from "@digestor/core/server";

/**
 * Starts Ask on the upload goal once the session is `ready`: the goal becomes the owner's first question. Safe to
 * call any number of times (a second ready, a restart, a pg-boss retry): `onlyIfEmpty` stores it only while the owner
 * has no Ask message in the session. A failed enqueue leaves the question and a failed answer; the session stays ready.
 */
export async function startGoalAsk(
  deps: { db: Db; enqueueAsk?: (messageId: string) => Promise<void> },
  sessionId: string,
): Promise<"started" | "skipped"> {
  if (!deps.enqueueAsk) return "skipped";
  const session = await getSession(deps.db, sessionId);
  const goal = session?.goal?.trim();
  if (!session || session.stage !== "ready" || !goal) return "skipped";
  const started = await startAskQuestion(deps.db, deps.enqueueAsk, {
    sessionId, ownerId: session.ownerId, text: goal, onlyIfEmpty: true, onEnqueueError: "fail",
  });
  return started ? "started" : "skipped";
}
