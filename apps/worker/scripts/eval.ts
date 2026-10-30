/**
 * Prints the evaluation table (spec §14a) for an already-analysed session. It never calls the LLM: it only reads
 * the session's current analysis version and compares it with a hand-labelled golden file.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval.ts <sessionId> <golden.json>
 *
 * It runs in the worker container (which has the database URL); the golden path is relative to `apps/worker`. The
 * session id may also be given as `sessionId` in the golden file.
 */
import { readFileSync } from "node:fs";
import { GranularitySchema, HIGHLIGHT_TYPES } from "@digestor/core";
import { createDb, getCurrentAnalysis } from "@digestor/core/server";
import { highlightTypeRecall, momentRecall, topicBoundaryError, trapHits, type Golden } from "../src/eval/metrics.js";

const [sessionArg, goldenPath] = process.argv.slice(2);
if (!goldenPath) {
  console.error("Usage: eval.ts <sessionId> <golden.json>");
  process.exit(1);
}
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
const sessionId = sessionArg || golden.sessionId;
if (!sessionId) {
  console.error("No session id: pass it as the first argument or set sessionId in the golden file.");
  process.exit(1);
}

const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  const analysis = await getCurrentAnalysis(db, sessionId);
  if (!analysis) {
    console.error(`Session ${sessionId} has no complete analysis.`);
    process.exit(1);
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

  const traps = trapHits(golden.traps, analysis.moments);
  rows.push(["Check warnings fired on traps", traps.total ? `${traps.fired}/${traps.total}` : "no traps"]);

  console.log(`Evaluation of session ${sessionId} (analysis v${analysis.version.version}, profile ${analysis.version.profile}; golden profile ${golden.profile})\n`);
  console.log("| Metric | Result |\n| --- | --- |");
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
} finally {
  await close();
}
