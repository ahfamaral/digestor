import { normName, SPEECH_HEADER_PATTERN } from "@digestor/core";
import type { Db, SpeechHit } from "@digestor/core/server";
import { cleanQuery } from "./params";
import { hybridSpeeches, queryTerms, searchTerms, typedPhrase, type Semantic, type Translate } from "./search";
import { semanticSearch, speechPassages, type PassagesResult } from "./semantic";

/**
 * "Ask the record" (extractive only): a question answered with passages quoted from the official speeches, never with
 * generated text. The speeches come from the topic search's hybrid retrieval (words and meaning, fused); the worker
 * then scores each speech's stored passages against the question, and the best one of each speech is quoted (1–3 of its
 * sentences, verbatim). At most `PER_DEPUTY` passages per deputy, so more voices show (diversity, not a ranking).
 */
export const ASK_POOL = 30;
export const ASK_SHOWN = 6;
export const PER_DEPUTY = 2;
/** Longest quote: whole sentences up to this many characters (a single longer sentence is cut at a word). */
export const QUOTE_CHARS = 450;
/** A passage with none of the question's words is quoted whole, up to this many characters (a stored chunk's cap). */
export const WHOLE_CHARS = 1000;
const QUOTE_SENTENCES = 3;

export type Passages = (q: string, speechKeys: string[], perSpeech: number) => Promise<PassagesResult>;
export type AskPassage = { speech: SpeechHit; sentences: string[] };
/** `ok: false`: the worker (search by meaning) couldn't answer; the page offers the word search instead. */
export type AskResult = { ok: boolean; passages: AskPassage[] };

export async function askRecord(
  db: Db, question: string,
  opts: { from?: string; to?: string; translate?: Translate; semantic?: Semantic; passages?: Passages } = {},
): Promise<AskResult> {
  const q = cleanQuery(question);
  if (!q) return { ok: true, passages: [] };
  const semantic = opts.semantic ?? ((s: string) => semanticSearch(s));
  const passages = opts.passages ?? ((s: string, keys: string[], n: number) => speechPassages(s, keys, n));
  // The search by meaning and the passages compare the question's topic ("price of food"): its framing ("What did
  // deputies say about") matches every speech that names a deputy. The translator gets the whole question.
  const topic = questionTopic(q);
  const [searched, meaning] = await Promise.all([searchTerms(q, opts.translate), semantic(topic)]);
  if (!meaning.ok) return { ok: false, passages: [] };
  const pool = await hybridSpeeches(db, {
    terms: queryTerms(searched), phrase: typedPhrase(topic), filters: { from: opts.from, to: opts.to }, meaningKeys: meaning.keys,
    limit: ASK_POOL, offset: 0,
  });
  const byKey = new Map(pool.rows.filter((r) => r.speechKey).map((r) => [r.speechKey!, r]));
  if (byKey.size === 0) return { ok: true, passages: [] };
  const scored = await passages(topic, [...byKey.keys()], 1);
  if (!scored.ok) return { ok: false, passages: [] };
  const stems = queryStems(q, searched.terms);
  const perDeputy = new Map<number, number>();
  const out: AskPassage[] = [];
  for (const p of scored.passages) {
    const speech = byKey.get(p.speechKey);
    if (!speech) continue;
    const n = perDeputy.get(speech.member.externalId) ?? 0;
    if (n >= PER_DEPUTY) continue;
    const sentences = pickSentences(p.sentences, stems);
    if (sentences.length === 0) continue;
    perDeputy.set(speech.member.externalId, n + 1);
    byKey.delete(p.speechKey);
    out.push({ speech, sentences });
    if (out.length === ASK_SHOWN) break;
  }
  return { ok: true, passages: out };
}

/** Words that say what is asked, not what about: never used to choose the quoted sentences. */
const QUESTION_WORDS = new Set(
  (
    "what which who whom whose when where why how does did say says said saying tell told think thought about " +
    "members member speak spoke speaking talk talked talking from with that this they them their there " +
    "have has had been were will would could should into over than then also only some more most other " +
    "quais qual quem quando onde como porque sobre dizem disse disseram dizer diz falar falam falou falaram fala falando " +
    "pensam pensa acham acha camara para pelo pela pelos pelas mais isso esse essa este esta estes estas esses essas " +
    "aquele aquela foram sido seria tem teve entre ainda tambem muito muitos"
  ).split(/\s+/).filter(Boolean),
);
/** Who is asked about (any deputy): not a content word. */
const ASKED_ABOUT = /^(deput|parlamentar|congress)/;
/** How a question is framed, in its opening words: left out by `questionTopic`. */
const FRAMING = new Set(
  (
    "what which who whom how did do does have has had say says said tell told talk talked talking speak spoke spoken think thought " +
    "about on of the a an they members member mps " +
    "o a os as que quais qual quem como de do da dos das em no na nos nas sobre acerca respeito tem têm dito falado " +
    "disseram dizem disse diz falaram falam falou fala pensam acham"
  ).split(/\s+/).map(normName),
);
/** The words after which the topic starts ("about", "sobre"): from there a deputy is part of the topic. */
const ABOUT = new Set(["about", "on", "sobre", "de", "acerca", "respeito"]);
/** Saying or asking-about words: without one, "Deputados federais e o aborto" is a topic, not framing. */
const SAYING = new Set(
  [...ABOUT, ..."say says said tell told talk talked talking speak spoke spoken think thought dito falado disseram dizem disse diz falaram falam falou fala pensam acham".split(" ")],
);
const bare = (token: string) => normName(token).replace(/[^\p{L}\p{N}]/gu, "");

/**
 * What a question is about: its opening framing ("What did deputies say about the", "O que os deputados disseram sobre
 * a") and the final question mark left out; the rest as typed. Deputies count as framing only before the about word
 * and only when the question says or asks about something ("What did deputies say about deputies' pay?" keeps
 * "deputies' pay"; "Deputados federais e o aborto" stays whole). The whole question when nothing would be left.
 */
export function questionTopic(q: string): string {
  const tokens = q.trim().split(/\s+/);
  let i = 0;
  let about = false;
  let said = false;
  let firstAsked = -1;
  for (; i < tokens.length; i++) {
    const w = bare(tokens[i]!);
    if (FRAMING.has(w)) {
      about ||= ABOUT.has(w);
      said ||= SAYING.has(w);
    } else if (!about && ASKED_ABOUT.test(w)) {
      if (firstAsked < 0) firstAsked = i;
    } else break;
  }
  if (firstAsked >= 0 && !said) i = firstAsked;
  const rest = tokens.slice(i).join(" ").replace(/[?？!.\s]+$/u, "");
  return rest || q;
}
const STEM = 5;
const words = (s: string) => normName(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stem = (w: string) => w.slice(0, STEM);

/**
 * The question's content words (and the translated search terms'), lowercased without accents, as 5-letter stems
 * ("preço"/"preços" → "preco", "alimentos"/"alimento" → "alime"). Short words and question words are left out.
 */
export function queryStems(q: string, terms: string[]): Set<string> {
  const out = new Set<string>();
  for (const w of [q, ...terms].flatMap(words)) {
    if (w.length < 4 || QUESTION_WORDS.has(w) || ASKED_ABOUT.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

const header = new RegExp(SPEECH_HEADER_PATTERN, "i");
/** A sentence that is only the stenographer's header ("DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO …"). */
const isHeader = (s: string) => /^\s*DISCURSO NA ÍNTEGRA ENCAMINHAD/i.test(s) && !s.replace(header, "").trim();

/** A sentence cut at the last word that fits `max` characters, with an ellipsis. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const at = s.lastIndexOf(" ", max - 1);
  return `${s.slice(0, at > 0 ? at : max - 1).trimEnd()}…`;
}

/** Whole-sentence edges: a start in capitals, a digit or a quote; an end in . ! ? or … (closing marks allowed). */
const WHOLE_START = /^["“‘'«(\[\p{Lu}\p{N}]/u;
const WHOLE_END = /[.!?…]["”’'»)\]]*$/u;

/** "…" at the quote's edges where it starts or ends mid-sentence (a long sentence the worker cut into pieces). */
function edges(quote: string[]): string[] {
  if (quote.length === 0) return quote;
  const out = [...quote];
  if (!WHOLE_START.test(out[0]!)) out[0] = `…${out[0]}`;
  const last = out.length - 1;
  if (!WHOLE_END.test(out[last]!)) out[last] = `${out[last]}…`;
  return out;
}

/** The whole passage, in sentences, up to `WHOLE_CHARS`; the sentence that doesn't fit is cut at a word. */
function wholePassage(s: string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (const x of s) {
    const room = WHOLE_CHARS - size - (out.length ? 1 : 0);
    if (x.length <= room) {
      out.push(x);
      size += x.length + (out.length > 1 ? 1 : 0);
      continue;
    }
    if (room >= 20) out.push(cut(x, room));
    else out[out.length - 1] = `${out[out.length - 1]!.replace(/…$/u, "")}…`;
    break;
  }
  return out;
}

/**
 * The sentences of a passage to quote: the one holding most of the question's words (the first on a tie), then its
 * neighbours (next, then previous) while the quote stays within `QUOTE_CHARS`, at most 3. When no sentence holds any
 * (an English question without the translator), the whole passage, up to `WHOLE_CHARS`. Sentences are never edited:
 * a single sentence over the cap is cut at a word, and "…" marks a quote that starts or ends mid-sentence.
 */
export function pickSentences(sentences: string[], stems: ReadonlySet<string>): string[] {
  const s = sentences.map((x) => x.trim()).filter((x) => x && !isHeader(x));
  if (s.length === 0) return [];
  const hits = s.map((x) => new Set(words(x).map(stem).filter((w) => stems.has(w))).size);
  let best = 0;
  for (let i = 1; i < s.length; i++) if (hits[i]! > hits[best]!) best = i;
  if (hits[best] === 0) return edges(wholePassage(s));
  if (s[best]!.length > QUOTE_CHARS) return edges([cut(s[best]!, QUOTE_CHARS)]);
  let [lo, hi] = [best, best];
  let size = s[best]!.length;
  while (hi - lo + 1 < QUOTE_SENTENCES) {
    const next = s[hi + 1];
    const prev = s[lo - 1];
    if (next !== undefined && size + 1 + next.length <= QUOTE_CHARS) {
      hi++;
      size += 1 + next.length;
    } else if (prev !== undefined && size + 1 + prev.length <= QUOTE_CHARS) {
      lo--;
      size += 1 + prev.length;
    } else break;
  }
  return edges(s.slice(lo, hi + 1));
}
