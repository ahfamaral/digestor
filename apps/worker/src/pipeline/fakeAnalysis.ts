// Test helper: FakeLLM responders for the analysis calls (topics, moments, punchlines, briefing, checks).
// Responders read the time range and moment ids from the prompt, so they fit any transcript and any call order.
import { formatTimestamp, parseTimestamp } from "@digestor/core";
import { briefings, topics, type Db } from "@digestor/core/server";
import type { FakeCall, FakeResponse } from "../llm/structured.js";

const RANGE = /from (\d+:\d\d:\d\d) to (\d+:\d\d:\d\d)/;

function rangeOf(call: FakeCall): { startMs: number; endMs: number } {
  const m = RANGE.exec(call.user);
  if (!m) throw new Error(`No time range in the "${call.name}" prompt`);
  return { startMs: parseTimestamp(m[1]!), endMs: parseTimestamp(m[2]!) };
}

const ts = (ms: number) => formatTimestamp(ms);

const moment = (o: { title: string; granularity: string; startMs: number; endMs: number; types: string[]; relevance: number }) => ({
  title: o.title,
  why: `${o.title} matters.`,
  highlightTypes: o.types,
  relevance: o.relevance,
  granularity: o.granularity,
  start: ts(o.startMs),
  end: ts(o.endMs),
  evidence: [],
});

export const topicsResponse = (topics: { title: string; startMs: number; endMs: number }[]) => ({
  topics: topics.map((t) => ({ title: t.title, summary: `About ${t.title}.`, start: ts(t.startMs), end: ts(t.endMs) })),
});

/** Per topic: one exchange (90 s from 3 s in, `heated`) and one passage inside it (30 s, `key_point`). */
export const momentsResponder: FakeResponse = (call: FakeCall) => {
  const r = rangeOf(call);
  const start = r.startMs + 3_000;
  return {
    moments: [
      moment({ title: "Exchange", granularity: "exchange", startMs: start, endMs: Math.min(r.endMs, start + 90_000), types: ["heated"], relevance: 90 }),
      moment({ title: "Passage", granularity: "passage", startMs: start + 27_000, endMs: start + 57_000, types: ["key_point"], relevance: 80 }),
    ],
  };
};

/** Per exchange: one 12 s punchline 30 s in (`quotable`). */
export const punchlinesResponder: FakeResponse = (call: FakeCall) => {
  const r = rangeOf(call);
  return {
    punchlines: [
      moment({ title: "Punchline", granularity: "punchline", startMs: r.startMs + 30_000, endMs: r.startMs + 42_000, types: ["quotable"], relevance: 85 }),
    ],
  };
};

/** Cites the first moment id listed in the prompt in the lead and in every topic section. */
export const briefingResponder: FakeResponse = (call: FakeCall) => {
  const ids = [...call.user.matchAll(/id=([0-9a-f-]{36})/g)].map((m) => m[1]!);
  const idxs = [...call.user.matchAll(/Topic idx=(\d+)/g)].map((m) => Number(m[1]));
  const cite = ids.slice(0, 1);
  return {
    lead: [{ text: "The session in one sentence.", momentIds: cite }],
    sections: idxs.map((topicIdx) => ({ topicIdx, summary: [{ text: "What this topic covers.", momentIds: cite }], keyQuote: null })),
  };
};

export const CHECKS_OK = {
  argumentComplete: true,
  continuesWith: null,
  unansweredQuestion: false,
  contextRisk: "",
  reportedSpeech: false,
  interpreter: false,
};

const times = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

/**
 * Responses for `runs` full analyses (each run: one topics call, then per-topic, per-exchange and per-highlight calls).
 * `topics` defaults to an empty answer, i.e. the whole-session fallback topic.
 */
export function analysisResponses(o: { topics?: { title: string; startMs: number; endMs: number }[]; runs?: number } = {}) {
  const runs = o.runs ?? 1;
  return {
    topics: times(runs, topicsResponse(o.topics ?? [])),
    moments: times(runs * 30, momentsResponder),
    punchlines: times(runs * 40, punchlinesResponder),
    briefing: times(runs, briefingResponder),
    checks: times(runs * 10, CHECKS_OK),
  };
}

/** An analysis where the model finds nothing: one fallback topic, no moments, an empty briefing (no error logs). */
export const emptyAnalysisResponses = () => ({
  topics: [{ topics: [] }],
  moments: [{ moments: [] }],
  briefing: [{ lead: [], sections: [] }],
});

/** A db whose first insert into `table` throws, as if the worker died right there. Everything else passes through. */
export function crashOnInsert(real: Db, table: "topics" | "briefings"): Db {
  const target = table === "topics" ? topics : briefings;
  let crashed = false;
  return new Proxy(real, {
    get(obj, prop, receiver) {
      if (prop === "insert") {
        return (t: Parameters<Db["insert"]>[0]) => {
          if (!crashed && t === target) {
            crashed = true;
            throw new Error("worker crashed");
          }
          return obj.insert(t);
        };
      }
      const v: unknown = Reflect.get(obj, prop, receiver);
      return typeof v === "function" ? v.bind(obj) : v;
    },
  });
}
