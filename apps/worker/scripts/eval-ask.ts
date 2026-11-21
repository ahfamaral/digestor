/**
 * Ask / RAG evaluation (task B1): retrieval quality (free) and answer quality (paid) against a hand-labelled golden file.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval-ask.ts eval/ask/<file>.ask.json [--answers] [--k 6]
 *
 * Retrieval mode asks the transcript index (Chroma + the real multilingual-e5 embedder) each question and prints recall@k
 * and MRR. `--answers` also runs `runAsk` for every question as owner `eval` (one question at a time, no history), parses
 * the `[hh:mm:ss]` citations and the quoted text, checks every quote against the transcript, prints the scores, what the
 * verify step did (from its `verify_answer` chip) and the LLM cost from the usage meter, and deletes its `eval` rows. The golden path is relative to `apps/worker`.
 * A question whose answer paused for approval (the model called a tool that changes something) changes nothing (no
 * approval comes) and is left out of the scores, listed as paused.
 */
import { readFileSync } from "node:fs";
import { ChromaClient } from "chromadb";
import { sql } from "drizzle-orm";
import { createDb, addAskMessage, deleteAskMessages, getAskMessage, getTranscript } from "@digestor/core/server";
import { OUT_OF_STEPS, runAsk } from "../src/agents/ask.js";
import { COULDNT_CONFIRM } from "../src/agents/verify.js";
import { answerScores, parseCitations, retrievalScores, type AskGolden } from "../src/eval/askMetrics.js";
import { usageRows } from "../src/eval/metrics.js";
import { llmConfigFromEnv } from "../src/llm/provider.js";
import { createOpenRouterLLM, createOpenRouterToolLLM } from "../src/llm/openrouter.js";
import { createAnthropicLLM } from "../src/llm/structured.js";
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

/**
 * Deletes everything owner "eval" made for this session (an Ask tool can add selections, personal moments or clips),
 * whatever the run's outcome, and logs what was left. Rows of any other owner are never matched.
 */
async function cleanup(): Promise<void> {
  try {
    const owner = sql`${EVAL_OWNER}`;
    const analyses = sql`(select id from analysis_versions where session_id = ${sessionId})`;
    const steps: [string, ReturnType<typeof sql>][] = [
      ["subtitle tracks and clips", sql`delete from clips where owner_id = ${owner} and session_id = ${sessionId} returning 1`],
      ["selections", sql`delete from selections where owner_id = ${owner} and moment_id in (select id from moments where analysis_id in ${analyses}) returning 1`],
      ["personal moments", sql`delete from moments where owner_id = ${owner} and analysis_id in ${analyses} returning 1`],
      ["find-more requests", sql`delete from find_more_requests where owner_id = ${owner} and analysis_id in ${analyses} returning 1`],
      ["problem reports", sql`delete from problem_reports where owner_id = ${owner} and session_id = ${sessionId} returning 1`],
      ["ask messages", sql`delete from ask_messages where owner_id = ${owner} and session_id = ${sessionId} returning 1`],
    ];
    const left: string[] = [];
    for (const [label, q] of steps) {
      const n = (await db.execute(q)).rowCount ?? 0;
      if (n > 0) left.push(`${n} ${label}`);
    }
    console.error(left.length ? `eval cleanup removed leftovers: ${left.join(", ")}` : "eval cleanup: nothing left behind");
  } catch (err) {
    console.error("eval cleanup FAILED, check owner 'eval' rows by hand:", err);
  }
}

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
    const judge = config.provider === "openrouter" ? createOpenRouterLLM(key, config.models) : createAnthropicLLM(key);
    const meter = new UsageMeter();
    const rows: Parameters<typeof answerScores>[0] = [];
    const verify = { sentBack: 0, couldntConfirm: 0, unchecked: 0, outOfSteps: 0, paused: 0, clarified: 0 };
    const detail: string[] = [];
    const started = Date.now();
    await withUsageMeter(meter, async () => {
      for (const q of golden.questions) {
        const user = await addAskMessage(db, { sessionId, ownerId: EVAL_OWNER, role: "user", text: q.question, status: "done" });
        const pending = await addAskMessage(db, { sessionId, ownerId: EVAL_OWNER, role: "assistant", text: "", status: "pending" });
        try {
          await runAsk({ db, llm, judge, search }, pending.id);
          const done = await getAskMessage(db, pending.id);
          if (done?.status === "waiting") {
            // Paused for approval: no answer to score (nothing was changed).
            verify.paused += 1;
            const asked = (Array.isArray(done.toolCalls) ? (done.toolCalls as { name: string }[]) : []).map((c) => c.name);
            detail.push(`${q.id} [paused for approval, not scored] tools so far: ${asked.join(", ") || "none"}`);
            console.error(`paused ${q.id}: waiting for approval`);
            continue;
          }
          const answer = done?.text ?? "";
          const { citedMs, quotes } = parseCitations(answer);
          const chip = (Array.isArray(done?.toolCalls) ? (done.toolCalls as { name: string; args: unknown; result: string }[]) : []).find((c) => c.name === "verify_answer");
          const rounds = Number((chip?.args as { rounds?: unknown } | undefined)?.rounds ?? 0);
          verify.sentBack += rounds > 0 ? 1 : 0;
          verify.couldntConfirm += answer.includes(COULDNT_CONFIRM) ? 1 : 0;
          verify.unchecked += chip?.result.includes("couldn't be checked") || chip?.result === "Couldn't be checked" ? 1 : 0;
          verify.clarified += (Array.isArray(done?.toolCalls) ? (done.toolCalls as { name: string }[]) : []).some((c) => c.name === "ask_user") ? 1 : 0;
          verify.outOfSteps += answer === OUT_OF_STEPS ? 1 : 0;
          rows.push({ q, answer, citedMs, quotesFound: quotes.map((x) => text.includes(norm(x))) });
          detail.push(`${q.id} [${done?.status}] verify ${chip ? `${chip.result}, sent back ${rounds}×` : "none"}; cited ${citedMs.map(clock).join(", ") || "none"}; quotes ${quotes.length ? quotes.map((x) => `${text.includes(norm(x)) ? "ok" : "NOT FOUND"}: "${x}"`).join(" | ") : "none"}\n    ${answer.replace(/\s+/g, " ").slice(0, 1500)}`);
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
    console.log(`| Answers sent back by verify | ${verify.sentBack} of ${s.n} |\n| Answers ending "I couldn't confirm" | ${verify.couldntConfirm} of ${s.n} |\n| Answers with parts not checked | ${verify.unchecked} of ${s.n} |\n| Gave up on the step limit | ${verify.outOfSteps} of ${s.n} |`);
    console.log(`Asked a clarifying question: ${verify.clarified} of ${s.n}`);
    if (verify.paused > 0) console.log(`| Paused for approval (not scored) | ${verify.paused} of ${golden.questions.length} |`);
    for (const [kk, v] of usageRows("Ask run", meter.report(), null)) console.log(`| ${kk} | ${v} |`);
    console.log("\nPer question:");
    for (const d of detail) console.log(d);
  }
} finally {
  await cleanup();
  await close();
}
