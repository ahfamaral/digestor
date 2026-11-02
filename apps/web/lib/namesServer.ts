import { getPersons, listAttributions, namesChangedAt, type Db } from "@digestor/core/server";
import type { NamesData } from "./names";

/** A session's attributions and the people they point at, as plain data for the screens (server only). */
export async function loadNames(db: Db, sessionId: string): Promise<NamesData> {
  const attributions = await listAttributions(db, sessionId);
  const ids = [...new Set(attributions.map((a) => a.personId).filter((p): p is string => p !== null))];
  return { persons: await getPersons(db, ids), attributions };
}

/** True when a name was confirmed or changed by a human or the record after the analysis version was written (its AI text may use earlier names). */
export async function namesChangedSince(db: Db, sessionId: string, namesAt: Date): Promise<boolean> {
  const changed = await namesChangedAt(db, sessionId);
  return changed !== null && changed.getTime() > namesAt.getTime();
}
