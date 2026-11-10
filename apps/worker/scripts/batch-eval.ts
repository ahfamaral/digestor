/**
 * Model comparison on one golden video: several fresh analyses per model, scored and costed, then (optionally) the
 * moment checks of each model as classifiers on the golden traps and on control moments. Run in the worker container
 * (it needs the database, ffmpeg for thumbnails and OPENROUTER_API_KEY), on a dev copy, never on prod:
 *
 *   pnpm --filter @digestor/worker exec tsx scripts/batch-eval.ts <sessionId> <golden.json> --models a,b,c [--runs 3]
 *     [--checks-models a,b,c] [--controls 24] [--out eval/results/<name>.json] [--skip-analysis]
 *
 * - Each analysis run is a new analysis version made in this process with that model as both the reasoning and the
 *   fast model (OpenRouter ids), reason "eval <model> run <n>". The transcript and context card are shared, so only
 *   the analysis differs. At the end the session's original current version is made current again.
 * - Results are appended to `--out` after every run, and a rerun skips the (model, run) pairs already there, so an
 *   interrupted batch resumes without paying twice.
 * - The checks test runs `checkMoment` with each checks model on the original version's moments that overlap a trap
 *   plus `--controls` moments clear of every trap (spread evenly). Nothing is stored.
 * - Prints Markdown tables: per model the mean (min–max) over runs of recall, topic error, highlight matches, moment
 *   count, minutes and US$ per run and per hour of video; and per checks model the warning rates.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GranularitySchema, ProfileIdSchema, type LLMUsage, type MomentChecks } from "@digestor/core";
import {
  createDb,
  failAnalysisVersion,
  getAnalysisVersion,
  getContextCard,
  getCurrentAnalysis,
  getRunningAnalysis,
  getSession,
  getTranscript,
  LocalStorage,
  makeAnalysisCurrent,
} from "@digestor/core/server";
import { checkMoment } from "../src/agents/checks.js";
import { checkScores, fmtSpread, pickControls, spread } from "../src/eval/batch.js";
import { highlightTypeRecall, momentRecall, topicBoundaryError, type Golden } from "../src/eval/metrics.js";
import { createOpenRouterLLM } from "../src/llm/openrouter.js";
import type { StructuredLLM } from "../src/llm/structured.js";
import { UsageMeter, withUsageMeter } from "../src/llm/usage.js";
import * as media from "../src/media/ffmpeg.js";
import { runAnalysis, withProfile } from "../src/pipeline/analysis.js";
import { promptCard } from "../src/pipeline/naming.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (name: string) => opt(name)?.split(",").map((m) => m.trim()).filter(Boolean) ?? [];
const valueFlags = new Set(["--models", "--runs", "--checks-models", "--controls", "--out"]);
const [sessionId, goldenPath] = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));
const models = list("--models");
const checkModels = list("--checks-models");
const runs = Number(opt("--runs") ?? 3);
const controlsN = Number(opt("--controls") ?? 24);
const skipAnalysis = args.includes("--skip-analysis");
if (!sessionId || !goldenPath || (!models.length && !checkModels.length) || !Number.isInteger(runs) || runs < 1) {
  console.error("Usage: batch-eval.ts <sessionId> <golden.json> --models a,b [--runs 3] [--checks-models a,b] [--controls 24] [--out file.json] [--skip-analysis]");
  process.exit(1);
}
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
const outPath = opt("--out") ?? `eval/results/${sessionId.slice(0, 8)}.json`;

type RunResult = {
  model: string;
  run: number;
  version: number | null;
  error: string | null;
  minutes: number;
  usage: LLMUsage;
  costUsd: number;
  topicErrorMeanS: number | null;
  recall: Record<string, number | null>;
  typesMatched: number | null;
  typesTotal: number;
  moments: Record<string, number>;
};
type CheckResult = { model: string; usage: LLMUsage; costUsd: number; failed: number; scores: ReturnType<typeof checkScores> };
type Results = { sessionId: string; golden: string; runs: RunResult[]; checks: CheckResult[] };

const results: Results = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { sessionId, golden: goldenPath, runs: [], checks: [] };
const save = () => {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
};
const llmFor = (model: string): StructuredLLM => ({
  modelIds: { reasoning: `openrouter:${model}`, fast: `openrouter:${model}` },
  generate: (a) => createOpenRouterLLM(key, { reasoning: model, fast: model }).generate(a),
});
const total = (u: LLMUsage) => Object.values(u).reduce((n, m) => n + m.costUsd, 0);

const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  const session = await getSession(db, sessionId);
  const original = await getCurrentAnalysis(db, sessionId);
  if (!session || !original) throw new Error(`Session ${sessionId} not found or has no complete analysis.`);
  const profile = ProfileIdSchema.parse(session.profile ?? original.version.profile);
  const hours = (session.durationMs ?? 0) / 3_600_000;
  const storage = new LocalStorage(process.env.DATA_DIR ?? "./data");
  console.error(`Session ${sessionId} (${hours.toFixed(2)} h, profile ${profile}); original current version v${original.version.version}; results in ${outPath}`);

  if (!skipAnalysis) {
    try {
      for (const model of models)
        for (let run = 1; run <= runs; run++) {
          if (results.runs.some((r) => r.model === model && r.run === run && !r.error)) continue;
          results.runs = results.runs.filter((r) => !(r.model === model && r.run === run)); // retry a failed run
          console.error(`analysing with ${model}, run ${run}/${runs}…`);
          const t0 = Date.now();
          const base: RunResult = { model, run, version: null, error: null, minutes: 0, usage: {}, costUsd: 0, topicErrorMeanS: null, recall: {}, typesMatched: null, typesTotal: 0, moments: {} };
          try {
            await runAnalysis({ db, storage, llm: llmFor(model), media }, sessionId, { profile, reason: `eval ${model} run ${run}` });
            const a = (await getCurrentAnalysis(db, sessionId))!;
            // The bundle's version leaves `usage` out; the version row has it.
            const usage = (await getAnalysisVersion(db, a.version.id))?.usage ?? {};
            const types = highlightTypeRecall(golden.moments, a.moments);
            const topicErr = topicBoundaryError(golden.topics, a.topics).meanMs;
            results.runs.push({
              ...base,
              version: a.version.version,
              minutes: (Date.now() - t0) / 60_000,
              usage,
              costUsd: total(usage),
              topicErrorMeanS: Number.isFinite(topicErr) ? topicErr / 1000 : null,
              recall: Object.fromEntries(
                GranularitySchema.options.map((g) => {
                  const r = momentRecall(golden.moments, a.moments, g);
                  return [g, r.total ? r.found / r.total : null];
                }),
              ),
              typesMatched: types.found,
              typesTotal: types.total,
              moments: Object.fromEntries(GranularitySchema.options.map((g) => [g, a.moments.filter((m) => m.granularity === g).length])),
            });
          } catch (err) {
            const running = await getRunningAnalysis(db, sessionId);
            if (running) await failAnalysisVersion(db, running.id);
            results.runs.push({ ...base, minutes: (Date.now() - t0) / 60_000, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
            console.error(`  failed: ${String(err).slice(0, 300)}`);
          }
          save();
        }
    } finally {
      await makeAnalysisCurrent(db, sessionId, original.version.id);
      console.error(`restored v${original.version.version} as the current version`);
    }
  }

  if (checkModels.length) {
    const [transcript, stored] = await Promise.all([getTranscript(db, sessionId), getContextCard(db, sessionId)]);
    if (!transcript || !stored) throw new Error("The session has no transcript or context card.");
    const card = await promptCard(db, sessionId, withProfile(stored.card, profile));
    const onTrap = original.moments.filter((m) => golden.traps.some((t) => Math.min(t.endMs, m.endMs) > Math.max(t.startMs, m.startMs)));
    const controls = pickControls(original.moments, golden.traps, controlsN);
    console.error(`checks test on v${original.version.version}: ${onTrap.length} moments on traps, ${controls.length} controls`);
    for (const model of checkModels) {
      if (results.checks.some((c) => c.model === model)) continue;
      const meter = new UsageMeter();
      const llm = createOpenRouterLLM(key, { reasoning: model, fast: model });
      let failed = 0;
      const run = async (ms: typeof onTrap) => {
        const out: { startMs: number; endMs: number; checks: MomentChecks | null }[] = [];
        for (let i = 0; i < ms.length; i += 4) {
          const batch = await Promise.all(
            ms.slice(i, i + 4).map(async (m) => {
              try {
                return { startMs: m.startMs, endMs: m.endMs, checks: await checkMoment(llm, { card, moment: m, words: transcript.words }) };
              } catch (err) {
                failed++;
                console.error(`  check failed (${model}): ${String(err).slice(0, 200)}`);
                return { startMs: m.startMs, endMs: m.endMs, checks: null };
              }
            }),
          );
          out.push(...batch);
        }
        return out;
      };
      console.error(`checks with ${model}…`);
      const [checkedTrap, checkedCtrl] = await withUsageMeter(meter, async () => [await run(onTrap), await run(controls)]);
      const usage = meter.report();
      results.checks.push({ model, usage, costUsd: total(usage), failed, scores: checkScores(golden.traps, checkedTrap, checkedCtrl) });
      save();
    }
  }

  // Tables over everything in the results file (earlier invocations included).
  const byModel = [...new Set(results.runs.map((r) => r.model))];
  if (byModel.length) {
    const pct = (x: number | null | undefined) => (typeof x === "number" ? x * 100 : null);
    console.log(`\n### Analysis: ${sessionId} (${hours.toFixed(2)} h), mean (min–max) over runs\n`);
    console.log(`| Model | Runs ok | Exchange recall | Passage recall | Punchline recall | Topic error, mean | Types matched (of ${golden.moments.reduce((n, m) => n + m.types.length, 0)}) | Moments | Minutes / run | US$ / run | US$ / hour of video |`);
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const model of byModel) {
      const ok = results.runs.filter((r) => r.model === model && !r.error);
      const all = results.runs.filter((r) => r.model === model);
      const cell = (f: (r: RunResult) => number | null, d = 0, unit = "") => fmtSpread(spread(ok.map(f)), d, unit);
      const served = [...new Set(ok.flatMap((r) => Object.keys(r.usage)))].filter((s) => s !== model);
      console.log(
        `| ${model}${served.length ? ` (served by ${served.join(", ")})` : ""} | ${ok.length}/${all.length} | ${cell((r) => pct(r.recall.exchange), 0, "%")} | ${cell((r) => pct(r.recall.passage), 0, "%")} | ${cell((r) => pct(r.recall.punchline), 0, "%")} | ${cell((r) => r.topicErrorMeanS, 1, " s")} | ${cell((r) => r.typesMatched)} | ${cell((r) => Object.values(r.moments).reduce((a, b) => a + b, 0))} | ${cell((r) => r.minutes, 1)} | ${cell((r) => r.costUsd, 3)} | ${cell((r) => (hours ? r.costUsd / hours : null), 3)} |`,
      );
    }
    const errors = results.runs.filter((r) => r.error);
    for (const r of errors) console.log(`\n- ${r.model} run ${r.run} failed: ${r.error}`);
  }
  if (results.checks.length) {
    const rate = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "n/a");
    console.log(`\n### Checks as classifiers (moments of the original version)\n`);
    console.log("| Model | Quoted opponent: traps fired | … warned on trap moments | … warned on controls | Mid-argument: traps fired | … warned on trap moments | … warned on controls | Failed calls | US$ |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const c of results.checks) {
      const q = c.scores.quoted_opponent;
      const m = c.scores.mid_argument;
      const served = Object.keys(c.usage).filter((s) => s !== c.model);
      console.log(
        `| ${c.model}${served.length ? ` (served by ${served.join(", ")})` : ""} | ${rate(q.trapsFired, q.traps)} | ${rate(q.trapMomentsWarned, q.trapMoments)} | ${rate(q.controlsWarned, q.controls)} | ${rate(m.trapsFired, m.traps)} | ${rate(m.trapMomentsWarned, m.trapMoments)} | ${rate(m.controlsWarned, m.controls)} | ${c.failed} | ${c.costUsd.toFixed(4)} |`,
      );
    }
  }
} finally {
  await close();
}
