import type { Collection } from "chromadb";
import { forgetRecordEmbeddings, markRecordsEmbedded, orphanRecordEmbeddings, recordsToEmbed, type RecordKind } from "@digestor/core/server";
import { embedSpeeches, MeaningIndexMissingError, type MeaningDeps } from "./embedSpeeches.js";

/**
 * Roll calls and bills in the meaning index, each its own Chroma collection: one short official text per record (a roll
 * call: bill label, bill summary and what was voted; a bill: label and summary), one vector each, no chunks. The deputy
 * page's vote and bill text boxes rank a deputy's own records with it; nothing here writes text.
 */
export const RECORD_COLLECTIONS: Record<RecordKind, string> = { roll_call: "monitor_camara_rollcalls", bill: "monitor_camara_bills" };
/** Records embedded per round (one Chroma write and one bookkeeping write per round). */
const RECORD_BATCH = 256;
/** A record's text is short (a bill summary averages 145 characters); a rare long one is cut for the model. */
const MAX_RECORD_CHARS = 1500;
/** Ids scored per Chroma read. */
const GET_BATCH = 500;

/** `collections`: test names for the two record collections (the speech collection stays `collection`). */
export type RecordDeps = MeaningDeps & { collections?: Partial<Record<RecordKind, string>> };
export type RecordHit = { id: string; score: number };
type Counts = { added: number; removed: number };

const nameOf = (d: RecordDeps, kind: RecordKind) => d.collections?.[kind] ?? RECORD_COLLECTIONS[kind];
const isNotFound = (err: unknown) => err instanceof Error && /not.?found|does not exist/i.test(`${err.name} ${err.message}`);

function slices<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Brings one kind's collection up to date: deletes the vectors of records gone (or a bill that lost its summary), then
 * embeds records not in it yet or whose text changed (the stored md5 differs), newest first, at most `max`. Safe to
 * rerun after a crash: the id is the record's id (upsert), and a record is recorded only after its vector is stored.
 */
export async function embedRecords(d: RecordDeps, kind: RecordKind, opts: { max?: number } = {}): Promise<Counts> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const col = await d.chroma.getOrCreateCollection({ name: nameOf(d, kind), embeddingFunction: null, configuration: { hnsw: { space: "cosine" } } });
  const orphans = await orphanRecordEmbeddings(d.db, kind);
  for (const part of slices(orphans, 500)) {
    await col.delete({ ids: part });
    await forgetRecordEmbeddings(d.db, kind, part);
  }
  let added = 0;
  while (added < max) {
    const todo = await recordsToEmbed(d.db, kind, Math.min(RECORD_BATCH, max - added));
    if (todo.length === 0) break;
    const vectors = await d.embedder.embed(todo.map((r) => r.text.slice(0, MAX_RECORD_CHARS)), "passage");
    if (vectors.length !== todo.length) throw new Error("The embedder returned the wrong number of vectors.");
    await col.upsert({ ids: todo.map((r) => r.id), embeddings: vectors, documents: todo.map((r) => r.text), metadatas: todo.map((r) => ({ date: r.date })) });
    await markRecordsEmbedded(d.db, kind, todo);
    added += todo.length;
  }
  return { added, removed: orphans.length };
}

/**
 * The daily run: new speeches first, then roll calls and bills with what is left of `max` (records counted one each,
 * like speeches), so one run never embeds more than `max` items. Orphans are removed even when nothing is left.
 */
export async function embedMonitor(d: RecordDeps, max: number): Promise<{ speeches: Counts; rollCalls: Counts; bills: Counts }> {
  const speeches = await embedSpeeches(d, { max });
  let left = Math.max(0, max - speeches.added);
  const rollCalls = await embedRecords(d, "roll_call", { max: left });
  left = Math.max(0, left - rollCalls.added);
  const bills = await embedRecords(d, "bill", { max: left });
  return { speeches, rollCalls, bills };
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

/**
 * These records ranked by closeness to the query (cosine of the stored, normalised vectors), best first, at most `k`.
 * Only the given ids are scored (a deputy's own votes or bills, already filtered), so a narrow filter loses nothing;
 * ids not in the index yet are skipped (they still match by words).
 */
export async function searchRecordMeaning(d: RecordDeps, kind: RecordKind, q: string, ids: string[], k: number): Promise<RecordHit[]> {
  let col: Collection;
  try {
    col = await d.chroma.getCollection({ name: nameOf(d, kind) });
  } catch (err) {
    if (isNotFound(err)) throw new MeaningIndexMissingError();
    throw err;
  }
  if (ids.length === 0) return [];
  const [qv] = await d.embedder.embed([q], "query");
  if (!qv) return [];
  const hits: RecordHit[] = [];
  for (const part of slices([...new Set(ids)], GET_BATCH)) {
    const got = await col.get({ ids: part, include: ["embeddings"] });
    for (const [i, id] of got.ids.entries()) {
      const v = got.embeddings[i];
      if (v) hits.push({ id, score: dot(qv, Array.from(v)) });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

/**
 * Loads the two record collections into Chroma at startup, so a deputy page's first vote or bill search after a restart
 * doesn't wait for it: a real read of stored vectors (as a search does) and one nearest-neighbour query (the HNSW index).
 * A `peek` alone was not enough (a cold first search still took 3.5 s, over the web's 3 s). Never throws.
 */
export async function warmRecordIndexes(d: RecordDeps): Promise<void> {
  for (const kind of ["roll_call", "bill"] as const) {
    try {
      const col = await d.chroma.getCollection({ name: nameOf(d, kind) });
      const got = await col.get({ limit: GET_BATCH, include: ["embeddings"] });
      const v = got.embeddings[0];
      if (v) await col.query({ queryEmbeddings: [Array.from(v)], nResults: 1, include: [] });
    } catch {
      // not built yet: the search answers 404 and the page shows word matches
    }
  }
}
