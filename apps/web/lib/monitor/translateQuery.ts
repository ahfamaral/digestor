import { z } from "zod";
import { normName } from "@digestor/core";
import type { TranslateResult } from "./search";

/**
 * The monitor's only LLM call: a search query in any language → Portuguese (Brazil) search terms for Postgres
 * full-text search. Results are always official text; the model never writes about anyone. One OpenRouter call
 * (json_schema, no sampling parameters: Claude 5.5 rejects them; `require_parameters` keeps OpenRouter from routing to
 * a provider that would drop the schema), validated with zod, then trimmed in code. Any failure searches the words
 * as typed and says so. https://openrouter.ai/docs/api-reference/overview
 */
const URL_ = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_TRANSLATE_MODEL = "anthropic/claude-haiku-5.5";
const MAX_TERMS = 4;
const MAX_TERM = 60;
const CACHE_SIZE = 500;

export const TRANSLATE_PROMPT =
  "You turn a search query into Portuguese (Brazil) search terms for the official records of the Brazilian Chamber of Deputies. Return the direct translation first, then up to 3 close terms a speech might use instead. Keep personal names, party names and bill numbers as written. If the query is already Portuguese, return it first unchanged. Return only search terms, never sentences or explanations.";

const SCHEMA = {
  type: "object",
  properties: { terms: { type: "array", items: { type: "string" } } },
  required: ["terms"],
  additionalProperties: false,
};
const reply = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });
const output = z.object({ terms: z.array(z.string()) });

const cache = new Map<string, TranslateResult>();
export function clearTranslateCache(): void {
  cache.clear();
}

/** At most `max` characters, cut at the last space so no word is cut in half (a single longer word is cut at `max`). */
function cutAtWord(t: string, max: number): string {
  if (t.length <= max) return t;
  const space = t.lastIndexOf(" ", max);
  return (space > 0 ? t.slice(0, space) : t.slice(0, max)).trim();
}

/** Trim, drop empties, cut to 60 characters at a word boundary, dedupe (case and accents), keep 4. */
function cleanTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = cutAtWord(raw.trim().replace(/\s+/g, " "), MAX_TERM);
    const key = normName(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

export async function translateQuery(
  q: string, o: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<TranslateResult> {
  const key = normName(q);
  const hit = cache.get(key);
  if (hit) return hit;
  const fallback: TranslateResult = { terms: [q], translated: false, failed: true };
  try {
    const res = await (o.fetch ?? fetch)(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json", "x-openrouter-title": "Digestor" },
      body: JSON.stringify({
        model: o.model || DEFAULT_TRANSLATE_MODEL,
        messages: [
          { role: "system", content: TRANSLATE_PROMPT },
          { role: "user", content: q },
        ],
        response_format: { type: "json_schema", json_schema: { name: "search_terms", strict: true, schema: SCHEMA } },
        provider: { require_parameters: true },
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
    const content = reply.parse(await res.json()).choices[0]!.message.content;
    const terms = cleanTerms(output.parse(JSON.parse(content)).terms);
    if (terms.length === 0) throw new Error("no terms");
    // "translated" means the first term is not the query itself: a Portuguese query stays first, plus close terms.
    const result: TranslateResult = { terms, translated: normName(terms[0]!) !== key, failed: false };
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn("monitor: query translation failed, searching as typed:", err instanceof Error ? err.message : err);
    return fallback;
  }
}
