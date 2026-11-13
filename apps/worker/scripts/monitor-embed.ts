/**
 * Builds or catches up the monitor's meaning index (Chroma collection `monitor_camara_speeches`): every speech with
 * text (or a summary) not in it yet, newest first, plus the removal of revised texts' old chunks. The daily
 * `monitor.embed` job does the same for the day's new speeches; this script is the first full run (about 8,000
 * speeches of 2026, local e5 model, no paid calls). Safe to stop and rerun: it continues where it stopped.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-embed.ts [--max N]
 */
import { ChromaClient } from "chromadb";
import { createDb } from "@digestor/core/server";
import { createE5Embedder } from "../src/search/embed.js";
import { embedSpeeches } from "../src/monitor/embedSpeeches.js";

const maxArg = process.argv.indexOf("--max");
const max = maxArg > 0 ? Number(process.argv[maxArg + 1]) : undefined;
const { db, close } = createDb(process.env.DATABASE_URL!);
const chromaUrl = new URL(process.env.CHROMA_URL ?? "http://localhost:8000");
const chroma = new ChromaClient({ host: chromaUrl.hostname, port: Number(chromaUrl.port || 80), ssl: chromaUrl.protocol === "https:" });
const embedder = createE5Embedder();
const started = Date.now();
const STEP = 500;
let total = { added: 0, removed: 0 };
try {
  // In steps of 500 speeches so progress shows; each step is a complete, recorded unit.
  for (;;) {
    const want = max === undefined ? STEP : Math.min(STEP, max - total.added);
    if (want <= 0) break;
    const r = await embedSpeeches({ db, chroma, embedder }, { max: want });
    total = { added: total.added + r.added, removed: total.removed + r.removed };
    console.log(`monitor embed: ${total.added} speeches added, ${total.removed} removed, ${Math.round((Date.now() - started) / 1000)} s`);
    if (r.added < want) break;
  }
  console.log("monitor embed done:", JSON.stringify(total), `in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await close();
}
