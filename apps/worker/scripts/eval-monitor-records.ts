/**
 * Evaluates a deputy's vote and bill text boxes on a golden query set: recall@10 and MRR@10 of the word search (as the
 * web runs it: the query translator's terms, frozen in the golden file, plus the typed phrase boost, best match first),
 * the search by meaning (e5 + Chroma over the deputy's own records, unfiltered top 10) and the hybrid the page shows
 * (`fuseRecords`: the closest meaning hits above the floor fused with the words by RRF). No paid calls.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval-monitor-records.ts [golden.json] [--pool out.json] [--sweep]
 *
 * `--pool out.json` writes, per query, the union of the three methods' top 10 with each record's text and meaning
 * score, for judging relevance by reading; `--sweep` prints hybrid recall@10 / MRR for other meaning cuts (top, floor).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ChromaClient } from "chromadb";
import { sql } from "drizzle-orm";
import { fuseRecords, phraseTerms, RECORD_MEANING, typedPhrase } from "@digestor/core";
import { createDb, getMember, memberBillIds, memberVoteIds } from "@digestor/core/server";
import { createE5Embedder } from "../src/search/embed.js";
import { searchRecordMeaning } from "../src/monitor/embedRecords.js";

type Golden = {
  labelledBy: string;
  queries: { id: string; kind: "rollCalls" | "bills"; q: string; lang: string; externalId: number; terms: string[]; relevant: string[] }[];
};
const TOP = 10;

const args = process.argv.slice(2);
const poolAt = args.indexOf("--pool");
const poolFile = poolAt >= 0 ? args[poolAt + 1] : undefined;
const sweep = args.includes("--sweep");
const goldenFile = args.find((a, i) => !a.startsWith("--") && (poolAt < 0 || i !== poolAt + 1)) ?? "eval/monitor-records.golden.json";
const golden = JSON.parse(readFileSync(goldenFile, "utf8")) as Golden;

const { db, close } = createDb(process.env.DATABASE_URL!);
const chromaUrl = new URL(process.env.CHROMA_URL ?? "http://localhost:8000");
const chroma = new ChromaClient({ host: chromaUrl.hostname, port: Number(chromaUrl.port || 80), ssl: chromaUrl.protocol === "https:" });
const deps = { db, chroma, embedder: createE5Embedder() };

const recall = (top: string[], rel: Set<string>) => (rel.size ? new Set(top.filter((k) => rel.has(k))).size / rel.size : 0);
const rr = (top: string[], rel: Set<string>) => {
  const i = top.findIndex((k) => rel.has(k));
  return i < 0 ? 0 : 1 / (i + 1);
};
const fmt = (n: number) => n.toFixed(2);
const methods = ["words", "meaning", "hybrid"] as const;
type Lists = Record<(typeof methods)[number], string[]>;
type Row = { id: string; kind: string; q: string; lang: string; rel: number } & Record<(typeof methods)[number], { recall: number; rr: number }>;

async function texts(kind: "rollCalls" | "bills", ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const r = kind === "rollCalls"
    ? await db.execute<{ id: string; t: string }>(sql`
        select id, concat_ws(' — ', bill_label, nullif(bill_summary, ''), description) as t from parl_roll_calls where id in (${list})`)
    : await db.execute<{ id: string; t: string }>(sql`
        select id::text as id, type || ' ' || number || '/' || year || ' — ' || summary as t from parl_bills where id::text in (${list})`);
  return new Map(r.rows.map((x) => [x.id, x.t]));
}

const rows: Row[] = [];
const pool: unknown[] = [];
const perQuery: { g: Golden["queries"][number]; words: string[]; meaning: { id: string; score: number }[] }[] = [];
try {
  for (const g of golden.queries) {
    const member = await getMember(db, "camara", g.externalId);
    if (!member) throw new Error(`${g.id}: deputy ${g.externalId} is not in the database`);
    const terms = phraseTerms(g.q, g.terms);
    const phrase = typedPhrase(g.q);
    const [candidates, words] = g.kind === "rollCalls"
      ? await Promise.all([memberVoteIds(db, member.id, {}), memberVoteIds(db, member.id, { q: terms, phrase })])
      : (await Promise.all([memberBillIds(db, member.id, {}), memberBillIds(db, member.id, { q: terms, phrase })])).map((l) => l.map(String));
    const meaning = await searchRecordMeaning(deps, g.kind === "rollCalls" ? "roll_call" : "bill", g.q, candidates, 50);
    perQuery.push({ g, words, meaning });
    const lists: Lists = { words, meaning: meaning.map((m) => m.id), hybrid: fuseRecords(words, meaning).list };
    const rel = new Set(g.relevant);
    const missing = [...rel].filter((r) => !candidates.includes(r));
    if (missing.length) console.warn(`${g.id}: ${missing.length} relevant record(s) not among the deputy's: ${missing.join(", ")}`);
    const row = { id: g.id, kind: g.kind, q: g.q, lang: g.lang, rel: rel.size } as Row;
    for (const m of methods) {
      const top = lists[m].slice(0, TOP);
      row[m] = { recall: recall(top, rel), rr: rr(top, rel) };
    }
    rows.push(row);
    if (poolFile) {
      const ids = [...new Set(methods.flatMap((m) => lists[m].slice(0, TOP)))];
      const t = await texts(g.kind, ids);
      const score = new Map(meaning.map((m) => [m.id, m.score]));
      pool.push({
        id: g.id, q: g.q, kind: g.kind, externalId: g.externalId, candidates: candidates.length,
        records: ids.map((id) => ({ id, by: methods.filter((m) => lists[m].slice(0, TOP).includes(id)), score: score.get(id) ?? null, text: t.get(id) ?? "" })),
      });
    }
  }
  if (poolFile) writeFileSync(poolFile, JSON.stringify(pool, null, 1));

  const avg = (rs: Row[], m: (typeof methods)[number], f: "recall" | "rr") => rs.reduce((s, r) => s + r[m][f], 0) / (rs.length || 1);
  console.log(`Golden: ${goldenFile} (${rows.length} queries; ${golden.labelledBy})`);
  console.log(`Hybrid cut: at most ${RECORD_MEANING.top} meaning hits, within ${RECORD_MEANING.within} of the best and at least ${RECORD_MEANING.min}\n`);
  console.log("| id | kind | query | lang | relevant | words R@10 | meaning R@10 | hybrid R@10 | words RR | meaning RR | hybrid RR |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.kind} | ${r.q} | ${r.lang} | ${r.rel} | ${methods.map((m) => fmt(r[m].recall)).join(" | ")} | ${methods.map((m) => fmt(r[m].rr)).join(" | ")} |`);
  }
  console.log("\n| subset | queries | words recall@10 | meaning recall@10 | hybrid recall@10 | words MRR | meaning MRR | hybrid MRR |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [name, rs] of [["all", rows], ["votes", rows.filter((r) => r.kind === "rollCalls")], ["bills", rows.filter((r) => r.kind === "bills")]] as const) {
    console.log(`| ${name} | ${rs.length} | ${methods.map((m) => fmt(avg(rs, m, "recall"))).join(" | ")} | ${methods.map((m) => fmt(avg(rs, m, "rr"))).join(" | ")} |`);
  }
  if (sweep) {
    // precision@10: relevant rows among the first 10 shown (or fewer when the list is shorter); the cut trades it for recall
    const prec = (top: string[], rel: Set<string>) => (top.length ? top.filter((k) => rel.has(k)).length / top.length : 0);
    console.log("\n| cut | hybrid recall@10 | hybrid precision@10 | hybrid MRR | meaning-only rows in the top 10 (avg) |");
    console.log("|---|---|---|---|---|");
    const cuts: { label: string; keep: (m: { id: string; score: number }[]) => { id: string; score: number }[] }[] = [];
    for (const top of [5, 10]) for (const min of [0, 0.8, 0.82, 0.84]) cuts.push({ label: `top ${top}, floor ${min}`, keep: (m) => m.filter((h) => h.score >= min).slice(0, top) });
    for (const within of [0.02, 0.03, 0.04]) cuts.push({ label: `top 10, within ${within} of the best`, keep: (m) => m.filter((h) => h.score >= (m[0]?.score ?? 0) - within).slice(0, 10) });
    for (const c of cuts) {
      let rec = 0, pr = 0, mrr = 0, extra = 0;
      for (const { g, words, meaning } of perQuery) {
        const { list, meaningOnly } = fuseRecords(words, c.keep(meaning), { top: 1000, min: -1 });
        const rel = new Set(g.relevant);
        const top10 = list.slice(0, TOP);
        rec += recall(top10, rel);
        pr += prec(top10, rel);
        mrr += rr(top10, rel);
        extra += top10.filter((id) => meaningOnly.includes(id)).length;
      }
      const n = perQuery.length || 1;
      console.log(`| ${c.label} | ${fmt(rec / n)} | ${fmt(pr / n)} | ${fmt(mrr / n)} | ${fmt(extra / n)} |`);
    }
  }
} finally {
  await close();
}
