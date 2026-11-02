import type { Word } from "./schemas.ts";
import type { Range } from "./snap.ts";

/** A voice must speak at least this long inside a range to count as present. */
export const FOCUS_MIN_MS = 3_000;

export type AttributionSource = "record" | "caption" | "transcript" | "metadata" | "human";
export type AttributionStatus = "proposed" | "confirmed" | "anonymous" | "rejected";
export type AttributionEvidence =
  | { kind: "record"; speechId: string; score: number; url: string; fetchedAt: string }
  | { kind: "caption"; frameKey: string; text: string; atMs: number }
  | { kind: "quote"; quote: string }
  | { kind: "none" };

export interface Person {
  id: string;
  displayName: string;
  fullName: string | null;
  kind: "official" | "custom";
  party: string | null;
  state: string | null;
  role: string | null;
  photoUrl: string | null;
  officialIds: Record<string, string>;
}

export interface Attribution {
  id: string;
  sessionId: string;
  speakerId: string;
  startMs: number | null;
  endMs: number | null;
  personId: string | null;
  source: AttributionSource;
  status: AttributionStatus;
  confidence: number;
  evidence: AttributionEvidence;
  createdBy: string;
  createdAt: Date;
  supersededAt: Date | null;
}

export type Resolution =
  | { kind: "named"; personId: string; confirmed: boolean; attribution: Attribution }
  | { kind: "anonymous"; attribution: Attribution }
  | { kind: "conflict"; attributions: Attribution[] }
  | { kind: "unnamed" };

export interface Turn {
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

const PROPOSED_SOURCE_ORDER: AttributionSource[] = ["record", "caption", "transcript", "metadata"];

const isRanged = (a: Attribution) => a.startMs !== null && a.endMs !== null;

function covers(a: Attribution, ms: number): boolean {
  if (a.startMs === null || a.endMs === null) return true;
  return a.startMs <= ms && ms < a.endMs;
}

/** Who a voice is at a moment: human > confirmed record > a single proposed person. */
export function personAt(atts: Attribution[], speakerId: string, ms: number): Resolution {
  const rows = atts.filter((a) => a.speakerId === speakerId && a.supersededAt === null && a.status !== "rejected" && covers(a, ms));

  const human = rows
    .filter((a) => a.source === "human")
    .sort((a, b) => Number(isRanged(b)) - Number(isRanged(a)) || b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (human) {
    if (human.status === "anonymous" || human.personId === null) return { kind: "anonymous", attribution: human };
    return { kind: "named", personId: human.personId, confirmed: true, attribution: human };
  }

  const record = rows
    .filter((a) => a.source === "record" && a.status === "confirmed" && a.personId !== null)
    .sort((a, b) => Number(isRanged(b)) - Number(isRanged(a)) || b.confidence - a.confidence)[0];
  if (record) return { kind: "named", personId: record.personId!, confirmed: true, attribution: record };

  const proposed = rows.filter((a) => a.status === "proposed" && a.personId !== null);
  const ids = new Set(proposed.map((a) => a.personId));
  if (ids.size > 1) return { kind: "conflict", attributions: proposed };
  if (ids.size === 1) {
    const best = [...proposed].sort((a, b) => PROPOSED_SOURCE_ORDER.indexOf(a.source) - PROPOSED_SOURCE_ORDER.indexOf(b.source))[0]!;
    return { kind: "named", personId: best.personId!, confirmed: false, attribution: best };
  }
  return { kind: "unnamed" };
}

function resolutionKey(res: Resolution, speakerId: string): string {
  if (res.kind === "named") return res.personId;
  if (res.kind === "anonymous") return `anon:${speakerId}`;
  return `none:${speakerId}`;
}

/** Voices speaking at least `minMs` inside `r`, longest first. */
export function peopleInRange(
  words: Word[],
  atts: Attribution[],
  r: Range,
  minMs: number = FOCUS_MIN_MS,
): { speakerId: string; resolution: Resolution; ms: number }[] {
  const totals = new Map<string, { speakerId: string; resolution: Resolution; ms: number }>();
  for (const w of words) {
    const ms = Math.min(w.endMs, r.endMs) - Math.max(w.startMs, r.startMs);
    if (ms <= 0) continue;
    const resolution = personAt(atts, w.speaker, w.startMs);
    const key = `${w.speaker}\u0000${resolutionKey(resolution, w.speaker)}`;
    const cur = totals.get(key);
    if (cur) cur.ms += ms;
    else totals.set(key, { speakerId: w.speaker, resolution, ms });
  }
  return [...totals.values()].filter((t) => t.ms >= minMs).sort((a, b) => b.ms - a.ms);
}

/** Consecutive words by the same voice, as one turn. */
export function turnsOf(words: Word[]): Turn[] {
  const turns: Turn[] = [];
  for (const w of words) {
    const last = turns[turns.length - 1];
    if (last && last.speakerId === w.speaker) {
      last.endMs = w.endMs;
      last.text += ` ${w.text}`;
    } else {
      turns.push({ speakerId: w.speaker, startMs: w.startMs, endMs: w.endMs, text: w.text });
    }
  }
  return turns;
}

export function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Persons whose name shares whole tokens with `name`: every token of one side is a token of the other. */
export function closeMatches(name: string, persons: Person[]): Person[] {
  const q = normaliseName(name).split(" ").filter(Boolean);
  if (q.length === 0) return [];
  return persons.filter((p) => {
    const c = normaliseName(p.displayName).split(" ").filter(Boolean);
    if (c.length === 0) return false;
    return q.every((t) => c.includes(t)) || c.every((t) => q.includes(t));
  });
}

/** Text for a voice on screen. Sensitive profiles never show an unconfirmed name. */
export function speakerLabel(
  res: Resolution,
  persons: ReadonlyMap<string, Person>,
  speakerId: string,
  sensitive: boolean,
): { text: string; badge: AttributionSource | null; proposed: boolean } {
  const fallback = { text: `Speaker ${speakerId}`, badge: null, proposed: false };
  if (res.kind !== "named") return fallback;
  if (sensitive && !res.confirmed) return fallback;
  const p = persons.get(res.personId);
  if (!p) return fallback;
  return { text: p.displayName, badge: res.attribution.source, proposed: !res.confirmed };
}
