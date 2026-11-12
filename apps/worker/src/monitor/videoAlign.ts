import { isWrittenOnly, normaliseName, VIDEO_MATCH_MIN } from "@digestor/core";
import { STOP, speechText } from "../records/align.js";

// Where each official speech is in its session's video, from YouTube's automatic captions (word-timed VTT). Trial on the
// 30 Jun 2026 plenary (5 h 45, 134 speeches): 125 of the 127 spoken speeches matched with score >= 0.6; starts land
// within 1-3 s and ends near word-exact (hand check of 12).

/** One caption word: seconds from the video's start, and the word normalised (lower case, no accents or punctuation). */
export type CaptionWord = { t: number; w: string };
export type VideoSpeech = { speechKey: string; startsAt: string; text: string };
export type VideoMatch = { speechKey: string; startS: number; endS: number; score: number };

/** Words that carry no meaning for matching: the record's stop words plus forms of address common in the plenary. */
const VIDEO_STOP: ReadonlySet<string> = new Set([
  ...STOP,
  ..."sr sra srs sras deputado deputada deputados deputadas aqui hoje porque pelo pela pelos pelas todos todas voce vamos estamos fazer feito entao assim onde qual quais".split(" "),
]);

/** Words searched for at each end of a speech. */
const ANCHOR_WORDS = 20;
/** A speech's stamp is a 4-minute stenography block that runs late: look this far before and after it. */
const BEFORE_STAMP_S = 15 * 60;
const AFTER_STAMP_S = 25 * 60;
/** Seconds shown before the first matched word, so the click lands just before the speaker starts. */
const LEAD_IN_S = 2;

const ts = (x: string) => {
  const [h, m, s] = x.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/**
 * The words of YouTube's automatic captions with their times. Each cue repeats the previous line and adds new words with
 * `<00:00:18.680><c> word</c>` timings; the 10 ms cues only repeat. So: every cue longer than 50 ms, its last line, each
 * word at its own timing (the first at the cue's start).
 */
export function captionWords(vtt: string): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (const block of vtt.replace(/\r\n/g, "\n").split("\n\n")) {
    const lines = block.trim().split("\n");
    const cue = lines.findIndex((l) => l.includes("-->"));
    if (cue === -1) continue;
    const [a, b] = lines[cue]!.split(" --> ").map((x) => ts(x.trim().split(/\s+/)[0]!));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b! - a! < 0.05) continue;
    const text = lines.slice(cue + 1).filter((l) => l.trim() !== "");
    const last = text[text.length - 1];
    if (!last) continue;
    let t = a!;
    last.split(/<(\d\d:\d\d:\d\d\.\d\d\d)>/).forEach((part, i) => {
      if (i % 2 === 1) {
        t = ts(part);
        return;
      }
      for (const w of normaliseName(part.replace(/<\/?c>/g, " ")).split(" ")) if (w) out.push({ t, w });
    });
  }
  return out;
}

const contentWords = (words: string[]) => words.filter((w) => w.length >= 3 && !VIDEO_STOP.has(w));

/** Seconds between two Brasília local timestamps ("YYYY-MM-DD HH:MM[:SS]"). */
export function secondsBetween(from: string, to: string): number {
  const p = (s: string) => Date.parse(`${s.replace(" ", "T").slice(0, 19).padEnd(19, ":00").slice(0, 19)}Z`);
  return (p(to) - p(from)) / 1000;
}

function cosine(a: string[], b: string[]): number {
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (const w of a) ca.set(w, (ca.get(w) ?? 0) + 1);
  for (const w of b) cb.set(w, (cb.get(w) ?? 0) + 1);
  let dot = 0;
  for (const [w, n] of ca) dot += n * (cb.get(w) ?? 0);
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  const d = norm(ca) * norm(cb);
  return d === 0 ? 0 : dot / d;
}

/**
 * Places each spoken speech in the video. For each speech: around its stamp (offset from the stream's start), the
 * position whose next words contain most of the speech's first 20 content words is its start (then moved to the first
 * of its first 6 words); after it, the same for its last 20 words gives the end. The score is the cosine of the
 * speech's content words against the captions between start and end. Speeches sent in writing, with under 8 content
 * words, or stamped outside the video are skipped; matches under `VIDEO_MATCH_MIN` are dropped.
 */
export function alignSpeeches(
  words: CaptionWord[], streamStart: string, durationS: number, speeches: VideoSpeech[],
  window: { beforeS: number; afterS: number } = { beforeS: BEFORE_STAMP_S, afterS: AFTER_STAMP_S },
): VideoMatch[] {
  const cap = words.filter((x) => x.w.length >= 3 && !VIDEO_STOP.has(x.w));
  if (cap.length === 0) return [];
  const idxAt = (t: number) => {
    let lo = 0;
    let hi = cap.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cap[mid]!.t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const bestAnchor = (keys: string[], lo: number, hi: number, span: number) => {
    const keySet = new Set(keys);
    let best = -1;
    let at = lo;
    for (let p = lo; p < Math.max(lo + 1, hi) && p < cap.length; p++) {
      const window = new Set<string>();
      for (let q = p; q < Math.min(cap.length, p + span); q++) window.add(cap[q]!.w);
      let hit = 0;
      for (const k of keySet) if (window.has(k)) hit++;
      const score = hit / Math.max(1, keySet.size);
      if (score > best) {
        best = score;
        at = p;
      }
    }
    return at;
  };

  const out: VideoMatch[] = [];
  for (const s of speeches) {
    if (isWrittenOnly(s.text)) continue;
    const t0 = secondsBetween(streamStart, s.startsAt);
    if (t0 < -window.beforeS - 45 * 60 || t0 > durationS + 10 * 60 + Math.max(0, window.beforeS - BEFORE_STAMP_S)) continue;
    const st = contentWords(normaliseName(speechText(s.text)).split(" "));
    if (st.length < 8) continue;
    const k = Math.min(ANCHOR_WORDS, st.length);
    const span = Math.floor(k * 1.6);
    let p0 = bestAnchor(st.slice(0, k), idxAt(t0 - window.beforeS), idxAt(t0 + window.afterS), span);
    const head = new Set(st.slice(0, 6));
    for (let q = p0; q < Math.min(cap.length, p0 + span); q++) {
      if (head.has(cap[q]!.w)) {
        p0 = q;
        break;
      }
    }
    // About one content word a second; allow 1.8x that plus two minutes.
    const pe = bestAnchor(st.slice(-k), p0, idxAt(cap[p0]!.t + st.length * 1.8 + 120), span);
    const tail = new Set(st.slice(-k));
    let peEnd = Math.min(cap.length - 1, pe + span - 1);
    while (peEnd > pe && !tail.has(cap[peEnd]!.w)) peEnd--;
    const score = cosine(st, cap.slice(p0, peEnd + 1).map((x) => x.w));
    if (score < VIDEO_MATCH_MIN) continue;
    out.push({
      speechKey: s.speechKey,
      startS: Math.max(0, Math.floor(cap[p0]!.t) - LEAD_IN_S),
      endS: Math.ceil(cap[peEnd]!.t) + 1,
      score: Math.round(score * 1000) / 1000,
    });
  }
  return out;
}

/** Typical lag of a stamp behind the speech's real start in a live stream (trial: 1-4 minutes). */
const TYPICAL_LAG_S = 150;

/**
 * For a video whose start time is unknown (uploaded after the session rather than streamed): a first pass over the
 * whole video places the speeches; the median gap between where the confident ones (score >= 0.8, at least 3) were
 * found and their stamps gives the video's real start, and a second, normal pass runs from there. Returns that start
 * and the matches (the first pass's when too few were confident).
 */
export function alignWithoutStart(words: CaptionWord[], guess: string, durationS: number, speeches: VideoSpeech[]): { streamStart: string; matches: VideoMatch[] } {
  const whole = { beforeS: durationS + 3600, afterS: durationS + 3600 };
  const wide = alignSpeeches(words, guess, durationS, speeches, whole);
  const stamp = new Map(speeches.map((s) => [s.speechKey, s.startsAt]));
  const drifts = wide
    .filter((m) => m.score >= 0.8)
    .map((m) => m.startS - secondsBetween(guess, stamp.get(m.speechKey)!))
    .sort((a, b) => a - b);
  if (drifts.length < 3) return { streamStart: guess, matches: wide };
  const drift = drifts[Math.floor(drifts.length / 2)]!;
  const shift = -(drift + TYPICAL_LAG_S);
  const base = Date.parse(`${guess.replace(" ", "T").slice(0, 19)}Z`) + shift * 1000;
  const streamStart = new Date(base).toISOString().slice(0, 19).replace("T", " ");
  return { streamStart, matches: alignSpeeches(words, streamStart, durationS, speeches) };
}
