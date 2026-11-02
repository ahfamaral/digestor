import { getPersons, listAttributions, type Db } from "@digestor/core/server";
import type { NamesData } from "./names";

/** A session's attributions and the people they point at, as plain data for the screens (server only). */
export async function loadNames(db: Db, sessionId: string): Promise<NamesData> {
  const attributions = await listAttributions(db, sessionId);
  const ids = [...new Set(attributions.map((a) => a.personId).filter((p): p is string => p !== null))];
  return { persons: await getPersons(db, ids), attributions };
}
