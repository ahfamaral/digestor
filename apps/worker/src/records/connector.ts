import type { ChamberId } from "@digestor/core";
import { bundestagConnector } from "./bundestag.js";
import { camaraConnector } from "./camara.js";
import { senadoConnector } from "./senado.js";
import { usHouseConnector, usSenateConnector } from "./usCongress.js";
import type { RecordConnector } from "./types.js";

export { RecordNotFoundError, RecordNotPublishedError, notPublishedOrNotFound, insidePublishWindow, waitingLine, type MemberInfo, type RecordConnector, type RecordSpeech } from "./types.js";

/** The connector of a house, or null while the house has none. Looked up per call (the Brazilian modules import this one). */
export function findConnector(chamber: ChamberId): RecordConnector | null {
  switch (chamber) {
    case "senado": return senadoConnector;
    case "camara": return camaraConnector;
    case "bundestag": return bundestagConnector;
    case "us_house": return usHouseConnector;
    case "us_senate": return usSenateConnector;
    default: return null;
  }
}

export function connectorFor(chamber: ChamberId): RecordConnector {
  const c = findConnector(chamber);
  if (!c) throw new Error(`No record connector for ${chamber} yet.`);
  return c;
}
