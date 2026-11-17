/**
 * Prints the evaluation table (spec §14a) for an already-analysed session: it reads one analysis version and compares
 * it with a hand-labelled golden file.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval.ts <sessionId> <golden.json> [--version N] [--run-checks]
 *
 * It runs in the worker container (which has the database URL); the golden path is relative to `apps/worker`. The
 * session id may also be given as `sessionId` in the golden file ("" as the first argument then). Without `--version`
 * it reads the current version. Moment checks only run on demand, so trap results count only checked moments:
 * `--run-checks` first checks every unchecked moment that overlaps a trap, with the model that version recorded for
 * checks (a plain Anthropic id runs today's fast model, with a warning when they differ), and stores the result as
 * the app would. Without it the script never calls the LLM.
 * The cost rows come from the version's recorded LLM usage (tokens and US$ per served model, since 2026-11-10) and,
 * with `--run-checks`, from the checks this run made.
 */
import { readFileSync } from "node:fs";
import { GranularitySchema, HIGHLIGHT_TYPES, ProfileIdSchema } from "@digestor/core";
import { createDb, getAnalysisByVersion, getAnalysisVersion, getContextCard, getCurrentAnalysis, getPersons, getSession, getTranscript, listAttributions, setMomentChecks } from "@digestor/core/server";
import { checkMoment } from "../src/agents/checks.js";
import { attributionScore, highlightTypeRecall, momentRecall, topicBoundaryError, trapHits, uncheckedOnTraps, usageRows, type Golden } from "../src/eval/metrics.js";
import { createOpenRouterLLM } from "../src/llm/openrouter.js";
import { MODEL_IDS, createAnthropicLLM, type StructuredLLM } from "../src/llm/structured.js";
import { UsageMeter, withUsageMeter } from "../src/llm/usage.js";
import { withProfile } from "../src/pipeline/analysis.js";
import { promptCard } from "../src/pipeline/naming.js";

const args = process.argv.slice(2);
const runChecks = args.includes("--run-checks");
const versionAt = args.indexOf("--version");
const versionArg = versionAt >= 0 ? Number(args[versionAt + 1]) : undefined;
const [sessionArg, goldenPath] = args.filter((a, i) => !a.startsWith("--") && (versionAt < 0 || i !== versionAt + 1));
if (!goldenPath || (versionArg !== undefined && !Number.isInteger(versionArg))) {
  console.error("Usage: eval.ts <sessionId> <golden.json> [--version N] [--run-checks]");
  process.exit(1);
}
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
const sessionId = sessionArg || golden.sessionId;
if (!sessionId) {
  console.error("No session id: pass it as the first argument or set sessionId in the golden file.");
  process.exit(1);
}

/**
 * The client for a recorded model id: `openrouter:<id>` or a plain Anthropic id. The Anthropic client always runs
 * today's fast model (checks use it), so an older recorded id gets a warning instead of being silently replaced.
 */
function llmFor(recorded: string): StructuredLLM {
  if (recorded.startsWith("openrouter:")) {
    const id = recorded.slice("openrouter:".length);
    return createOpenRouterLLM(process.env.OPENROUTER_API_KEY ?? "", { reasoning: id, fast: id });
  }
  if (recorded !== MODEL_IDS.fast) {
    console.error(`Warning: this version recorded checks model ${recorded}; the checks run with today's ${MODEL_IDS.fast}.`);
  }
  return createAnthropicLLM(process.env.ANTHROPIC_API_KEY ?? "");
}

const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  let analysis = versionArg === undefined ? await getCurrentAnalysis(db, sessionId) : await getAnalysisByVersion(db, sessionId, versionArg);
  if (!analysis) {
    console.error(`Session ${sessionId} has no complete analysis${versionArg === undefined ? "" : ` v${versionArg}`}.`);
    process.exit(1);
  }
  const versionRow = await getAnalysisVersion(db, analysis.version.id);
  const models = (versionRow?.models ?? {}) as Record<string, string>;
  const checksMeter = new UsageMeter();

  if (runChecks) {
    const pending = uncheckedOnTraps(golden.traps, analysis.moments);
    const [transcript, stored] = await Promise.all([getTranscript(db, sessionId), getContextCard(db, sessionId)]);
    const profile = ProfileIdSchema.parse(analysis.version.profile);
    if (pending.length && (!transcript || !stored || !models.checks)) {
      console.error("Can't run checks: the session has no transcript or context card, or the version recorded no checks model.");
      process.exit(1);
    }
    const llm = pending.length ? llmFor(models.checks!) : null;
    const card = stored ? await promptCard(db, sessionId, withProfile(stored.card, profile)) : null;
    await withUsageMeter(checksMeter, async () => {
      for (const [i, m] of pending.entries()) {
        const checks = await checkMoment(llm!, { card: card!, moment: m, words: transcript!.words });
        await setMomentChecks(db, m.id, checks);
        console.error(`checked ${i + 1}/${pending.length}: ${m.granularity} ${m.title}`);
      }
    });
    if (pending.length) analysis = (await getAnalysisByVersion(db, sessionId, analysis.version.version))!;
  }
  const s = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "n/a");
  const rows: [string, string][] = [];

  const topics = topicBoundaryError(golden.topics, analysis.topics);
  rows.push(["Topic boundary error, mean", s(topics.meanMs)], ["Topic boundary error, max", s(topics.maxMs)]);

  for (const g of GranularitySchema.options) {
    const r = momentRecall(golden.moments, analysis.moments, g);
    rows.push([`Moment recall, ${g}`, r.total ? `${r.found}/${r.total} (${Math.round((100 * r.found) / r.total)}%)` : "no golden moments"]);
  }

  const goldenTypes = new Set(golden.moments.flatMap((m) => m.types));
  const types = highlightTypeRecall(golden.moments, analysis.moments);
  rows.push([`Highlight type matched (${[...goldenTypes].map((t) => HIGHLIGHT_TYPES[t].label).join(", ") || "none"})`, types.total ? `${types.found}/${types.total}` : "no golden types"]);

  for (const kind of ["mid_argument", "quoted_opponent"] as const) {
    const of = golden.traps.filter((t) => t.kind === kind);
    const r = trapHits(of, analysis.moments);
    const unchecked = uncheckedOnTraps(of, analysis.moments).length;
    rows.push([`Check warnings fired on traps, ${kind}`, r.total ? `${r.fired}/${r.total}${unchecked ? ` (${unchecked} overlapping moments unchecked)` : ""}` : "no traps"]);
  }
  const count = (g: string) => analysis.moments.filter((m) => m.granularity === g).length;
  rows.push(["Moments found (exchange / passage / punchline)", GranularitySchema.options.map(count).join(" / ")]);

  if (golden.speakers?.length) {
    const [transcript, atts] = await Promise.all([getTranscript(db, sessionId), listAttributions(db, sessionId)]);
    if (!transcript) rows.push(["Attribution score", "no transcript"]);
    else {
      const persons = await getPersons(db, [...new Set(atts.flatMap((a) => (a.personId ? [a.personId] : [])))]);
      const pct = (ms: number, total: number) => `${s(ms)} (${total ? Math.round((100 * ms) / total) : 0}%)`;
      for (const [label, rowsOf] of [["AI only", atts.filter((a) => a.source !== "human")], ["as stored", atts]] as const) {
        const r = attributionScore(golden.speakers, transcript.words, rowsOf, persons);
        rows.push(
          [`Speaking time named correctly, ${label}`, pct(r.correctMs, r.totalMs)],
          [`Speaking time named wrongly, ${label}`, pct(r.wrongMs, r.totalMs)],
          [`Speaking time unnamed, ${label}`, pct(r.unnamedMs, r.totalMs)],
          [`Attribution score, ${label}`, `${r.score.toFixed(2)} (correct - 5 x wrong, over ${s(r.totalMs)}; ${s(r.correctConfirmedMs)} correct and confirmed)`],
        );
      }
    }
  }

  const durationMs = (await getSession(db, sessionId))?.durationMs ?? null;
  rows.push(...usageRows("analysis", versionRow?.usage ?? {}, durationMs));
  if (runChecks) rows.push(...usageRows("checks run now", checksMeter.report(), null));

  console.log(`Evaluation of session ${sessionId} (analysis v${analysis.version.version}, profile ${analysis.version.profile}; golden profile ${golden.profile})`);
  console.log(`Models: ${[...new Set(Object.values(models))].join(", ") || "not recorded"}\n`);
  console.log("| Metric | Result |\n| --- | --- |");
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
} finally {
  await close();
}
