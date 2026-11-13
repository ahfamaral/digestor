import { sql, type SQL } from "drizzle-orm";
import { fightinWords } from "../fightinWords.ts";
import { MONITOR_STOPLIST } from "../monitorStoplist.ts";
import type { Db } from "./client.ts";

// Parliament monitor: "Words used more than the chamber". Counting only (no model, no AI): the speeches' official text,
// stemmed by Postgres (`pt_unaccent`), compared with the whole chamber by weighted log-odds (`fightinWords`).

/**
 * Fewer counted words than this and the section says there isn't enough text yet (a few speeches give noisy words).
 * Counted words leave out stopwords and the stoplist: 1,500 is about 3,000 spoken words (179 of 448 deputies on the dev
 * data, against 89 at 3,000; coordinator's ruling 2026-11-13, the owner can change it).
 */
export const WORDS_MIN_TOKENS = 1500;
/** A month with fewer counted words than this has no heat (one word in a two-line speech would look "much more"). */
export const WORDS_MIN_MONTH_TOKENS = 300;
export const WORDS_LIMIT = 20;
/**
 * A word is listed only when the target uses it clearly more than the rest of the chamber (z of the weighted log-odds
 * ≥ 1.96, never shown) and said it at least `WORDS_MIN_COUNT` times: with 1,500 words the prior alone lets a word said
 * twice reach the bar.
 */
export const WORDS_MIN_Z = 1.96;
export const WORDS_MIN_COUNT = 5;

export type WordsTarget = { memberId: number } | { party: string };
export type DistinctiveWord = {
  stem: string;
  /** The form the target wrote most often ("agrotóxicos" for `agrotox`). */
  label: string;
  /** Times the target said it (for ordering and tests; the page shows no numbers). */
  count: number;
  /**
   * One entry per month with speech text in the chamber (`YYYY-MM`): the word's share of the target's words that month
   * divided by its share of the rest of the chamber's (everyone else; a big party is not compared with itself).
   * `Infinity` when only the target said it that month; null when the target has under `minMonthTokens` words then.
   */
  months: { month: string; share: number | null }[];
};

/** A chair's turn inside another deputy's speech ("O SR. PRESIDENTE (Hugo Motta. Bloco/REPUBLICANOS - PB) - Conclua,
 * Deputado."), up to the next speaker header or the end. Never the speech's own opening header (the chair's own speech):
 * the turn must follow other text. Postgres gives a whole regex the greediness of its first quantified atom (and an
 * alternation like `(O SR|A SRA)` counts as greedy), so it starts with the non-greedy `[OA]{1,1}?`: the match then stops
 * at the first header that follows instead of running to the end of the speech. */
const CHAIR_TURN = "(?<=\\S\\s)[OA]{1,1}? SRA?\\. PRESIDENT[EA] \\([^)]*\\).*?(?=(O SR|A SRA)\\. [^()[:lower:]]{1,80}\\(|$)";
/** The chair's name in a chair header ("Hugo Motta", "Dr. Zacharias Calil", "Bacelar"). */
const CHAIR_NAME = "(?:O SR|A SRA)\\. PRESIDENT[EA] \\(((?:(?:Dr|Dra|Prof|Profa|Pr)\\. )?[^().]+)[.)]";

/**
 * Every chair's full name found in chair headers, as one regex alternation (longest first, metacharacters escaped), or a
 * never-matching pattern when there is none. Data-driven: whoever presided is in the record.
 */
const chairAlternation = sql`(
  select coalesce(string_agg(regexp_replace(name, '([][\\^$.|?*+(){}])', '\\\\\\1', 'g'), '|' order by length(name) desc, name), chr(1))
  from (select distinct trim((regexp_matches(text, ${sql.raw(`'${CHAIR_NAME}'`)}, 'g'))[1]) as name from parl_speeches) c
  where length(name) >= 4)`;

/**
 * The text as its speaker said it: without the speaker headers the Câmara prints before each turn ("O SR. FULANO (PL -
 * SP. Sem revisão do orador.) -", "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO FULANO (SEM REGISTRO
 * TAQUIGRÁFICO).", "O Sr. FULANO (PL-SP) pronuncia…"), which hold the speaker's own name and party; without the chair's
 * turns inside the speech; and, when `chairs` (from `chairAlternation`) is given, without the vocative to the chair
 * ("Sr. Presidente Hugo Motta,", "Presidente, Deputado Charles Fernandes"), full names only: a first name alone stays. A
 * header name is written in capitals, so the matches never run into the speech itself.
 */
const body = (text: SQL, chairs?: SQL) => {
  const turns = sql`regexp_replace(${text}, ${sql.raw(`'${CHAIR_TURN}'`)}, ' ', 'g')`;
  const vocatives = chairs
    ? sql`regexp_replace(${turns}, '(Sra?\\. )?President[ae],? (Deputad[oa] )?(' || ${chairs} || ')\\M', ' ', 'g')`
    : turns;
  return sql`regexp_replace(regexp_replace(${vocatives},
  'DISCURSO NA ÍNTEGRA[^()[:lower:]]{0,160}\\([^)]{0,80}\\)\\.?', ' ', 'g'),
  '(O|A) (SR|SRA|Sr|Sra)\\. [^()[:lower:]]{1,80}\\([^)]{0,200}\\)', ' ', 'g')`;
};

/** Stems kept: letters only (after `unaccent`), at least 3 of them, not in the stoplist. */
const KEEP_STEM = "^[a-z]{3,}$";

/**
 * Rebuilds `parl_word_counts` from every speech with text, in one transaction (delete, then insert-select): per deputy,
 * party on the day (`''` when unknown) and month, each stem of `to_tsvector('pt_unaccent', text)` and how many positions
 * it has. Run after the speeches and their party on the day are refreshed. Returns the rows written.
 */
export async function refreshWordCounts(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`delete from parl_word_counts`);
    const r = await tx.execute(sql`
      insert into parl_word_counts (member_id, party, month, stem, n)
      with stop as (
        select l.lexeme from unnest(to_tsvector('pt_unaccent', ${MONITOR_STOPLIST.join(" ")})) l
      ), chairs as (
        select ${chairAlternation} as alt
      ), speech as (
        select member_id, coalesce(party, '') as party, date_trunc('month', starts_at)::date as month,
          ${body(sql`text`, sql`chairs.alt`)} as body
        from parl_speeches cross join chairs where text <> '' and not text_file
      )
      select s.member_id, s.party, s.month, l.lexeme, sum(coalesce(array_length(l.positions, 1), 1))::int
      from speech s cross join lateral unnest(to_tsvector('pt_unaccent', s.body)) l
      where l.lexeme ~ ${KEEP_STEM} and l.lexeme not in (select lexeme from stop)
      group by 1, 2, 3, 4`);
    return r.rowCount ?? 0;
  });
}

/**
 * The words a deputy (or a party, by the party on the day of each speech) uses more than the rest of the chamber, best
 * first, with a month-by-month heat (`DistinctiveWord.months`). Under `minTokens` counted words: `enough: false` and no
 * words. `year`: only that year's months.
 */
export async function distinctiveWords(
  db: Db,
  who: WordsTarget,
  opts: {
    limit?: number; minTokens?: number; minMonthTokens?: number; year?: number; alpha0?: number; minZ?: number; minCount?: number;
  } = {},
): Promise<{ enough: boolean; words: DistinctiveWord[] }> {
  const {
    limit = WORDS_LIMIT, minTokens = WORDS_MIN_TOKENS, minMonthTokens = WORDS_MIN_MONTH_TOKENS, minZ = WORDS_MIN_Z, minCount = WORDS_MIN_COUNT,
  } = opts;
  const isTarget = "memberId" in who ? sql`member_id = ${who.memberId}` : sql`party = ${who.party}`;
  const inYear = opts.year ? sql`month >= make_date(${opts.year}::int, 1, 1) and month < make_date(${opts.year}::int + 1, 1, 1)` : sql`true`;

  const totals = await db.execute<{ stem: string; t: number; c: number }>(sql`
    select stem, (sum(n) filter (where ${isTarget}))::int as t, sum(n)::int as c
    from parl_word_counts where ${inYear} group by stem`);
  const target = new Map<string, number>();
  const chamber = new Map<string, number>();
  let nTarget = 0;
  for (const r of totals.rows) {
    chamber.set(r.stem, r.c);
    if (r.t) {
      target.set(r.stem, r.t);
      nTarget += r.t;
    }
  }
  if (nTarget < Math.max(minTokens, 1)) return { enough: false, words: [] };

  const rest = new Map<string, number>();
  for (const [stem, c] of chamber) {
    const rc = c - (target.get(stem) ?? 0);
    if (rc > 0) rest.set(stem, rc);
  }
  const top = fightinWords(target, rest, chamber, { alpha0: opts.alpha0 })
    .filter((w) => w.nTarget >= Math.max(minCount, 1) && w.z >= minZ)
    .slice(0, limit);
  if (top.length === 0) return { enough: true, words: [] };
  const stems = top.map((w) => w.stem);

  type Cell = { month: string; t: number | null; c: number };
  const [byMonth, byMonthStem, labels] = await Promise.all([
    db.execute<Cell>(sql`
      select to_char(month, 'YYYY-MM') as month, (sum(n) filter (where ${isTarget}))::int as t, sum(n)::int as c
      from parl_word_counts where ${inYear} group by month`),
    db.execute<Cell & { stem: string }>(sql`
      select to_char(month, 'YYYY-MM') as month, stem, (sum(n) filter (where ${isTarget}))::int as t, sum(n)::int as c
      from parl_word_counts where ${inYear} and stem = any(${sql.param(stems)}::text[]) group by month, stem`),
    surfaceForms(db, who, stems, opts.year),
  ]);
  const monthTotals = new Map(byMonth.rows.map((r) => [r.month, { t: r.t ?? 0, c: r.c }]));
  const cell = new Map(byMonthStem.rows.map((r) => [`${r.month}|${r.stem}`, { t: r.t ?? 0, c: r.c }]));
  const months = [...monthTotals.keys()].sort();
  return {
    enough: true,
    words: top.map((w) => ({
      stem: w.stem,
      label: labels.get(w.stem) ?? w.stem,
      count: w.nTarget,
      months: months.map((month) => {
        const tot = monthTotals.get(month)!;
        if (tot.t < Math.max(minMonthTokens, 1)) return { month, share: null };
        const x = cell.get(`${month}|${w.stem}`);
        if (!x || x.t === 0) return { month, share: 0 };
        const restWords = tot.c - tot.t;
        const restUses = x.c - x.t;
        return { month, share: restUses > 0 && restWords > 0 ? x.t / tot.t / (restUses / restWords) : Infinity };
      }),
    })),
  };
}

/**
 * The most common written form of each stem in the target's own speeches, in one query: every word token of the text
 * (headers removed, as counted), grouped as written, stemmed with the same config, the most frequent form per stem.
 */
async function surfaceForms(db: Db, who: WordsTarget, stems: string[], year?: number): Promise<Map<string, string>> {
  const isTarget = "memberId" in who ? sql`s.member_id = ${who.memberId}` : sql`coalesce(s.party, '') = ${who.party}`;
  const inYear = year ? sql`s.starts_at >= make_date(${year}::int, 1, 1) and s.starts_at < make_date(${year}::int + 1, 1, 1)` : sql`true`;
  const r = await db.execute<{ stem: string; token: string }>(sql`
    with words as (
      select t.token, count(*) as n
      from parl_speeches s cross join lateral ts_parse('default', ${body(sql`s.text`)}) t
      where ${isTarget} and ${inYear} and s.text <> '' and not s.text_file
        and t.tokid in (select tokid from ts_token_type('default') where alias in ('asciiword', 'word', 'hword_part', 'hword_asciipart'))
      group by t.token
    ), stemmed as (
      select token, n, (select l.lexeme from unnest(to_tsvector('pt_unaccent', token)) l limit 1) as stem from words
    )
    select distinct on (stem) stem, token from stemmed where stem = any(${sql.param(stems)}::text[]) order by stem, n desc, token`);
  return new Map(r.rows.map((x) => [x.stem, x.token]));
}
