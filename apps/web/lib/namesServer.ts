import { namesChangedSince as changedSince } from "@digestor/core";
import { getPersons, listAttributionHistory, listAttributions, type Db } from "@digestor/core/server";
import type { NamesData } from "./names";

/** A session's attributions and the people they point at, as plain data for the screens (server only). */
export async function loadNames(db: Db, sessionId: string): Promise<NamesData> {
  const attributions = await listAttributions(db, sessionId);
  const ids = [...new Set(attributions.map((a) => a.personId).filter((p): p is string => p !== null))];
  return { persons: await getPersons(db, ids), attributions };
}

/** True when some voice resolves to a different name (or to none) than when the analysis version was written: its AI text may use earlier names. A mere confirmation is no change. */
export async function namesChangedSince(db: Db, sessionId: string, namesAt: Date): Promise<boolean> {
  return changedSince(await listAttributionHistory(db, sessionId), namesAt);
}
