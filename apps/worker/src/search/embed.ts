import { createHash } from "node:crypto";

export interface Embedder {
  /** One normalised vector per text. e5 models want "passage: " on indexed text and "query: " on questions. */
  embed(texts: string[], kind: "passage" | "query"): Promise<number[][]>;
}

export const E5_MODEL = "Xenova/multilingual-e5-small";
const BATCH = 16;

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/** Local multilingual embeddings (384-dim). The model (~120 MB, cached in HF_HOME) is loaded once, on first use. */
export function createE5Embedder(): Embedder {
  let extractor: Promise<Extractor> | undefined;
  const load = (): Promise<Extractor> =>
    (extractor ??= import("@huggingface/transformers")
      .then(async ({ pipeline, env }) => {
        // transformers.js ignores HF_HOME (it caches inside node_modules); point it at the shared data volume.
        if (process.env.HF_HOME) env.cacheDir = process.env.HF_HOME;
        return (await pipeline("feature-extraction", E5_MODEL)) as unknown as Extractor;
      })
      .catch((err) => {
        extractor = undefined; // a failed download is retried on the next call
        throw err;
      }));
  return {
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      const run = await load();
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH).map((t) => `${kind}: ${t}`);
        out.push(...(await run(batch, { pooling: "mean", normalize: true })).tolist());
      }
      return out;
    },
  };
}

/** Deterministic 8-dim unit vector from a hash of the text: identical text gives an identical vector. */
export class FakeEmbedder implements Embedder {
  readonly calls: { texts: string[]; kind: "passage" | "query" }[] = [];
  async embed(texts: string[], kind: "passage" | "query"): Promise<number[][]> {
    this.calls.push({ texts, kind });
    return texts.map((t) => {
      const h = createHash("sha256").update(t).digest();
      const v = Array.from({ length: 8 }, (_, i) => h[i]! - 127.5);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
