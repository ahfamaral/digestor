import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RecordKind } from "@digestor/core/server";
import { MeaningIndexMissingError, type MeaningHit, type Passage } from "./monitor/embedSpeeches.js";
import type { RecordHit } from "./monitor/embedRecords.js";

/**
 * The worker's internal HTTP endpoint (node:http, no auth): never published beyond the host's loopback (dev) or the
 * compose network (prod, where the web app reaches it at http://worker:8790). It serves the monitor's search by meaning,
 * which needs the e5 model and Chroma the worker already holds. Every failure answers JSON (503 when the search
 * itself fails); nothing here can crash the worker.
 */
export type HttpDeps = {
  search(q: string, k: number): Promise<MeaningHit[]>;
  passages(q: string, speechKeys: string[], perSpeech: number): Promise<Passage[]>;
  /** A deputy's own roll calls or bills (`ids`, already filtered by the web app) ranked by meaning. */
  searchRecords(kind: RecordKind, q: string, ids: string[], k: number): Promise<RecordHit[]>;
};

export const DEFAULT_HTTP_PORT = 8790;
const MAX_BODY = 64 * 1024;
const MAX_Q = 500;
const DEFAULT_K = 100;
const MAX_K = 200;
const MAX_KEYS = 50;
const DEFAULT_PER_SPEECH = 3;
const MAX_PER_SPEECH = 10;
/**
 * `kind` → the record kind, the shape of its ids and how many one search takes: a deputy's votes or bills after the
 * other filters (the most prolific signed about 2,800 bills in 2026). Sized for the 64 KB body: a bill id ("2512345")
 * costs about 10 bytes in JSON, a roll-call id ("2500080-320") up to 14, so 5,000 and 3,000.
 */
const RECORD_KINDS = {
  rollCalls: { kind: "roll_call", id: /^\d{1,12}-\d{1,6}$/, max: 3000, noun: "roll call" },
  bills: { kind: "bill", id: /^\d{1,12}$/, max: 5000, noun: "bill" },
} as const;
const UNAVAILABLE = "Search by meaning isn't available right now.";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "The request is too large.");
    parts.push(chunk as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "The request body must be a JSON object.");
}

function query(body: Record<string, unknown>): string {
  const q = typeof body.q === "string" ? body.q.replace(/\s+/g, " ").trim().slice(0, MAX_Q) : "";
  if (!q) throw new HttpError(400, "Type something to search for.");
  return q;
}

/** A whole number within [1, max], else the default (a larger one is capped). */
function bounded(v: unknown, fallback: number, max: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : fallback;
}

export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://worker").pathname;
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
    if (req.method === "POST" && path === "/monitor/search") {
      const body = await readJson(req);
      const q = query(body);
      const k = bounded(body.k, DEFAULT_K, MAX_K);
      if (body.kind === undefined || body.kind === "speeches") return send(res, 200, { hits: await deps.search(q, k) });
      if (body.kind !== "rollCalls" && body.kind !== "bills") throw new HttpError(400, "kind must be speeches, rollCalls or bills.");
      const spec = RECORD_KINDS[body.kind];
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length > spec.max || !ids.every((id) => typeof id === "string" && spec.id.test(id))) {
        throw new HttpError(400, `ids must be a list of at most ${spec.max} ${spec.noun} ids.`);
      }
      try {
        return send(res, 200, { hits: await deps.searchRecords(spec.kind, q, ids as string[], k) });
      } catch (err) {
        // the worker is up, only this index isn't built yet (right after an update): the web fails this search only
        if (err instanceof MeaningIndexMissingError) throw new HttpError(404, "This search by meaning isn't built yet.");
        throw err;
      }
    }
    if (req.method === "POST" && path === "/monitor/passages") {
      const body = await readJson(req);
      const q = query(body);
      const keys = body.speechKeys;
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string") || keys.length > MAX_KEYS) {
        throw new HttpError(400, `speechKeys must be a list of at most ${MAX_KEYS} speech keys.`);
      }
      const passages = await deps.passages(q, keys as string[], bounded(body.perSpeech, DEFAULT_PER_SPEECH, MAX_PER_SPEECH));
      return send(res, 200, { passages });
    }
    send(res, 404, { error: "Not found." });
  };
  return (req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(`worker http ${req.method} ${req.url}:`, err);
      send(res, 503, { error: UNAVAILABLE });
    });
  };
}

/** Starts listening; a failure to listen (port taken) is logged, never thrown, so the job worker keeps running. */
export function startHttpServer(deps: HttpDeps, port = DEFAULT_HTTP_PORT, host = "0.0.0.0"): Server {
  const server = createServer(createHttpHandler(deps));
  server.requestTimeout = 30_000;
  server.on("error", (err) => console.error("worker http:", err));
  server.listen(port, host);
  return server;
}
