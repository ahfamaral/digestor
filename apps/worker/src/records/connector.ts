import type { ChamberId } from "@digestor/core";
import { bundestagConnector } from "./bundestag.js";
import { camaraConnector } from "./camara.js";
import { senadoConnector } from "./senado.js";
import type { RecordConnector } from "./types.js";

export { RecordNotFoundError, RecordNotPublishedError, notPublishedOrNotFound, waitingLine, type MemberInfo, type RecordConnector, type RecordSpeech } from "./types.js";

/** The connector of a house, or null while the house has none. Looked up per call (the Brazilian modules import this one). */
export function findConnector(chamber: ChamberId): RecordConnector | null {
  switch (chamber) {
    case "senado": return senadoConnector;
    case "camara": return camaraConnector;
    case "bundestag": return bundestagConnector;
    default: return null;
  }
}

export function connectorFor(chamber: ChamberId): RecordConnector {
  const c = findConnector(chamber);
  if (!c) throw new Error(`No record connector for ${chamber} yet.`);
  return c;
}
