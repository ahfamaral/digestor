import type { Word } from "./schemas.js";
import { endsSentence } from "./snap.js";
import { formatTimestamp } from "./time.js";

export type Sentence = { startMs: number; endMs: number; speaker: string; text: string };

const SENTENCE_GAP_MS = 1500;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

function joinWords(words: Word[]): string {
  let out = "";
  for (const [i, word] of words.entries()) {
    if (i > 0) {
      const prev = out.slice(-1);
      const next = word.text.charAt(0);
      if (!(CJK.test(prev) && CJK.test(next))) out += " ";
    }
    out += word.text;
  }
  return out;
}

export function toSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (!first || !last) return;
    sentences.push({ startMs: first.startMs, endMs: last.endMs, speaker: first.speaker, text: joinWords(cur) });
    cur = [];
  };
  for (const word of words) {
    const prev = cur[cur.length - 1];
    if (prev && (prev.speaker !== word.speaker || word.startMs - prev.endMs >= SENTENCE_GAP_MS)) flush();
    cur.push(word);
    if (endsSentence(word.text)) flush();
  }
  flush();
  return sentences;
}

export function renderTranscript(sentences: Sentence[]): string {
  return sentences.map((s) => `[${formatTimestamp(s.startMs)}] ${s.speaker}: ${s.text}`).join("\n");
}

export function speakerShares(words: Word[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of words) counts[w.speaker] = (counts[w.speaker] ?? 0) + 1;
  const shares: Record<string, number> = {};
  for (const [speaker, n] of Object.entries(counts)) shares[speaker] = n / words.length;
  return shares;
}

export function sliceWords(words: Word[], r: { startMs: number; endMs: number }): Word[] {
  return words.filter((w) => w.endMs > r.startMs && w.startMs < r.endMs);
}
