/**
 * Evaluates the monitor's topic search on a golden query set: recall@10 and MRR@10 of the word search (as the web runs
 * it: the query translator's terms, frozen in the golden file, plus the typed phrase boost), the search by meaning
 * (e5 + Chroma) and the hybrid (Reciprocal Rank Fusion of the top 100 of each). No paid calls.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval-monitor-search.ts [golden.json] [--pool out.json]
 *
 * `--pool out.json` writes, per query, the union of the three methods' top 10 with each speech's official summary and
 * opening, for judging relevance by reading (the golden's `relevant` lists come from that).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ChromaClient } from "chromadb";
import { sql } from "drizzle-orm";
import { phraseTerms, rrf, typedPhrase } from "@digestor/core";
import { createDb, speechKeysByWords } from "@digestor/core/server";
import { createE5Embedder } from "../src/search/embed.js";
import { searchSpeechMeaning } from "../src/monitor/embedSpeeches.js";

type Golden = {
  labelledBy: string;
  queries: { id: string; q: string; lang: string; terms: string[]; relevant: { externalId: number; startsAt: string }[] }[];
};
const TOP = 10;
const FUSE = 100;

const args = process.argv.slice(2);
const poolAt = args.indexOf("--pool");
const poolFile = poolAt >= 0 ? args[poolAt + 1] : undefined;
const goldenFile = args.find((a, i) => !a.startsWith("--") && (poolAt < 0 || i !== poolAt + 1)) ?? "eval/monitor-search.golden.json";
const golden = JSON.parse(readFileSync(goldenFile, "utf8")) as Golden;

const { db, close } = createDb(process.env.DATABASE_URL!);
const chromaUrl = new URL(process.env.CHROMA_URL ?? "http://localhost:8000");
const chroma = new ChromaClient({ host: chromaUrl.hostname, port: Number(chromaUrl.port || 80), ssl: chromaUrl.protocol === "https:" });
const deps = { db, chroma, embedder: createE5Embedder() };

const id = (externalId: number, startsAt: string) => `${externalId}@${startsAt}`;
const ids = await db.execute<{ speech_key: string; external_id: number; starts_at: string; summary: string; text: string }>(sql`
  select s.speech_key, m.external_id, to_char(s.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at, s.summary, left(s.text, 600) as text
  from parl_speeches s join parl_members m on m.id = s.member_id where s.speech_key is not null`);
const byKey = new Map(ids.rows.map((r) => [r.speech_key, r]));
const ident = (key: string) => {
  const r = byKey.get(key);
  return r ? id(r.external_id, r.starts_at) : key;
};

const recall = (top: string[], rel: Set<string>) => (rel.size ? top.filter((k) => rel.has(k)).length / rel.size : 0);
const rr = (top: string[], rel: Set<string>) => {
  const i = top.findIndex((k) => rel.has(k));
  return i < 0 ? 0 : 1 / (i + 1);
};
const fmt = (n: number) => n.toFixed(2);

const methods = ["words", "meaning", "hybrid"] as const;
type Row = { id: string; q: string; lang: string; rel: number } & Record<(typeof methods)[number], { recall: number; rr: number }>;
const rows: Row[] = [];
const pool: unknown[] = [];
try {
  for (const g of golden.queries) {
    const words = (await speechKeysByWords(db, { terms: phraseTerms(g.q, g.terms), phrase: typedPhrase(g.q), limit: FUSE })).keys;
    const meaning = (await searchSpeechMeaning(deps, g.q, FUSE)).map((h) => h.speechKey);
    const hybrid = rrf([words, meaning]).map((r) => r.key);
    const lists = { words, meaning, hybrid };
    const rel = new Set(g.relevant.map((r) => id(r.externalId, r.startsAt)));
    const row = { id: g.id, q: g.q, lang: g.lang, rel: rel.size } as Row;
    for (const m of methods) {
      const top = lists[m].slice(0, TOP).map(ident);
      row[m] = { recall: recall(top, rel), rr: rr(top, rel) };
    }
    rows.push(row);
    if (poolFile) {
      const keys = [...new Set(methods.flatMap((m) => lists[m].slice(0, TOP)))];
      pool.push({
        id: g.id, q: g.q,
        candidates: keys.map((k) => {
          const s = byKey.get(k)!;
          return {
            id: ident(k), by: methods.filter((m) => lists[m].slice(0, TOP).includes(k)),
            summary: s.summary.slice(0, 400), opening: s.text.replace(/^\s*(?:O|A)\s+SRA?\.\s+[^(\n]+?\s*\([^)\n]*\)\s*[-–—]\s*/, "").slice(0, 300),
          };
        }),
      });
    }
  }
  if (poolFile) writeFileSync(poolFile, JSON.stringify(pool, null, 1));

  const avg = (rs: Row[], m: (typeof methods)[number], f: "recall" | "rr") => rs.reduce((s, r) => s + r[m][f], 0) / (rs.length || 1);
  console.log(`Golden: ${goldenFile} (${rows.length} queries; ${golden.labelledBy})\n`);
  console.log("| id | query | lang | relevant | words R@10 | meaning R@10 | hybrid R@10 | words RR | meaning RR | hybrid RR |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.q} | ${r.lang} | ${r.rel} | ${methods.map((m) => fmt(r[m].recall)).join(" | ")} | ${methods.map((m) => fmt(r[m].rr)).join(" | ")} |`);
  }
  console.log("\n| subset | queries | words recall@10 | meaning recall@10 | hybrid recall@10 | words MRR | meaning MRR | hybrid MRR |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [name, rs] of [["all", rows], ["pt", rows.filter((r) => r.lang === "pt")], ["en", rows.filter((r) => r.lang === "en")]] as const) {
    console.log(`| ${name} | ${rs.length} | ${methods.map((m) => fmt(avg(rs, m, "recall"))).join(" | ")} | ${methods.map((m) => fmt(avg(rs, m, "rr"))).join(" | ")} |`);
  }
} finally {
  await close();
}
