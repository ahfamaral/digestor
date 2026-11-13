/**
 * Ask / RAG evaluation (task B1): retrieval quality (free) and answer quality (paid) against a hand-labelled golden file.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval-ask.ts eval/ask/<file>.ask.json [--answers] [--k 6]
 *
 * Retrieval mode asks the transcript index (Chroma + the real multilingual-e5 embedder) each question and prints recall@k
 * and MRR. `--answers` also runs `runAsk` for every question as owner `eval` (one question at a time, no history), parses
 * the `[hh:mm:ss]` citations and the quoted text, checks every quote against the transcript, prints the scores and the LLM
 * cost from the usage meter, and deletes its `eval` rows. The golden path is relative to `apps/worker`.
 */
import { readFileSync } from "node:fs";
import { ChromaClient } from "chromadb";
import { createDb, addAskMessage, deleteAskMessages, getAskMessage, getTranscript } from "@digestor/core/server";
import { runAsk } from "../src/agents/ask.js";
import { answerScores, parseCitations, retrievalScores, type AskGolden } from "../src/eval/askMetrics.js";
import { usageRows } from "../src/eval/metrics.js";
import { llmConfigFromEnv } from "../src/llm/provider.js";
import { createOpenRouterToolLLM } from "../src/llm/openrouter.js";
import { createAnthropicToolLLM } from "../src/llm/tools.js";
import { UsageMeter, withUsageMeter } from "../src/llm/usage.js";
import { createE5Embedder } from "../src/search/embed.js";
import { searchTranscript } from "../src/search/index.js";

const EVAL_OWNER = "eval";
const args = process.argv.slice(2);
const withAnswers = args.includes("--answers");
const kAt = args.indexOf("--k");
const k = kAt >= 0 ? Number(args[kAt + 1]) : 6;
const goldenPath = args.find((a, i) => !a.startsWith("--") && (kAt < 0 || i !== kAt + 1));
if (!goldenPath || !Number.isInteger(k) || k < 1) {
  console.error("Usage: eval-ask.ts <golden.json> [--answers] [--k 6]");
  process.exit(1);
}
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as AskGolden;
const sessionId = golden.sessionId;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const pct = (x: number) => `${Math.round(100 * x)}%`;

const chromaUrl = new URL(process.env.CHROMA_URL ?? "http://localhost:8000");
const chroma = new ChromaClient({
  host: chromaUrl.hostname,
  port: Number(chromaUrl.port || (chromaUrl.protocol === "https:" ? 443 : 80)),
  ssl: chromaUrl.protocol === "https:",
});
const embedder = createE5Embedder();
const search = (id: string, q: string, n: number) => searchTranscript({ chroma, embedder }, id, q, n);
const { db, close } = createDb(process.env.DATABASE_URL!);

try {
  // Retrieval (free).
  const hits = new Map<string, { startMs: number; endMs: number }[]>();
  const retrievalRows: string[] = [];
  for (const q of golden.questions) {
    const res = await search(sessionId, q.question, k);
    hits.set(q.id, res);
    const rank = res.findIndex((h) => q.expect.some((e) => h.startMs < e.endMs && e.startMs < h.endMs));
    retrievalRows.push(`| ${q.id} | ${q.answerable ? "yes" : "no"} | ${q.question} | ${q.answerable ? (rank >= 0 ? String(rank + 1) : "miss") : `top score ${(res[0]?.score ?? 0).toFixed(2)}`} |`);
  }
  const r = retrievalScores(golden.questions, hits, k);
  console.log(`Ask retrieval, session ${sessionId} (${golden.questions.length} questions, ${r.n} answerable, k=${k})`);
  console.log(`recall@${k} ${r.recallAtK.toFixed(2)} · MRR ${r.mrr.toFixed(2)}\n`);
  console.log("| Question | Answerable | Text | First hit rank |\n| --- | --- | --- | --- |");
  for (const row of retrievalRows) console.log(row);

  if (withAnswers) {
    const transcript = await getTranscript(db, sessionId);
    if (!transcript) throw new Error("The session has no transcript.");
    const text = norm(transcript.words.map((w) => w.text).join(" "));
    const config = llmConfigFromEnv();
    const key = process.env[config.keyVar];
    if (!key) throw new Error(`${config.keyVar} is not set.`);
    const llm = config.provider === "openrouter" ? createOpenRouterToolLLM(key, config.models) : createAnthropicToolLLM(key);
    const meter = new UsageMeter();
    const rows: Parameters<typeof answerScores>[0] = [];
    const detail: string[] = [];
    const started = Date.now();
    await withUsageMeter(meter, async () => {
      for (const q of golden.questions) {
        const user = await addAskMessage(db, { sessionId, ownerId: EVAL_OWNER, role: "user", text: q.question, status: "done" });
        const pending = await addAskMessage(db, { sessionId, ownerId: EVAL_OWNER, role: "assistant", text: "", status: "pending" });
        try {
          await runAsk({ db, llm, search }, pending.id);
          const done = await getAskMessage(db, pending.id);
          const answer = done?.text ?? "";
          const { citedMs, quotes } = parseCitations(answer);
          rows.push({ q, answer, citedMs, quotesFound: quotes.map((x) => text.includes(norm(x))) });
          detail.push(`${q.id} [${done?.status}] cited ${citedMs.map(clock).join(", ") || "none"}; quotes ${quotes.length ? quotes.map((x) => `${text.includes(norm(x)) ? "ok" : "NOT FOUND"}: "${x}"`).join(" | ") : "none"}\n    ${answer.replace(/\s+/g, " ").slice(0, 1500)}`);
          console.error(`answered ${rows.length}/${golden.questions.length}: ${q.id}`);
        } finally {
          await deleteAskMessages(db, [user.id, pending.id]);
        }
      }
    });
    const s = answerScores(rows);
    console.log(`\nAsk answers, model ${config.models.reasoning} via ${config.provider}, ${s.n} questions, ${Math.round((Date.now() - started) / 1000)} s`);
    console.log("| Metric | Result |\n| --- | --- |");
    console.log(`| Citation hit (answerable) | ${pct(s.citationHit)} |\n| Quote exact | ${pct(s.quoteExact)} |\n| Refusal correct (unanswerable) | ${pct(s.refusalCorrect)} |`);
    for (const [kk, v] of usageRows("Ask run", meter.report(), null)) console.log(`| ${kk} | ${v} |`);
    console.log("\nPer question:");
    for (const d of detail) console.log(d);
  }
} finally {
  await close();
}
