import { readFileSync } from "node:fs";
import type { Transcript, Word } from "@digestor/core";
import { stripRecordMarkup } from "./align.js";
import type { RecordSpeech } from "./senado.js";

/** Test helpers over the recorded Senado fixtures (shapes as the real API answers; see `senado.ts`). */
const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
const discursos = fx("senado-discursos-2026-09-02.json");
const textos = fx("senado-textos-2026-09-02.json").texts as Record<string, string>;
const senador = fx("senado-senador-5906.json");

export { discursos as fixtureDiscursos };
export const FIXTURE_DATE = "2026-09-02";
/** The fixture day's speeches in record order, with the speaker codes (the one with a recorded senator page is 5906). */
export const FIXTURE_SPEECHES = [
  { id: "524179", code: "6335" }, { id: "524182", code: "739" }, { id: "524138", code: "631" },
  { id: "524139", code: "6340" }, { id: "524142", code: "5906" },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type FakeSenadoOptions = { list?: () => Response | Promise<Response>; text?: (id: string) => Response; senador?: (code: string) => Response };

/** A `fetch` that answers the three Senado routes from the fixtures; `calls` records every URL. */
export function fakeSenadoFetch(o: FakeSenadoOptions = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/plenario/lista/discursos/")) return (await o.list?.()) ?? json(discursos);
    const t = url.match(/texto-integral\/(\d+)$/);
    if (t) return o.text?.(t[1]!) ?? new Response(textos[t[1]!] ?? "", { status: textos[t[1]!] ? 200 : 404 });
    const s = url.match(/senador\/(\d+)\.json$/);
    if (s) return o.senador?.(s[1]!) ?? (s[1] === "5906" ? json(senador) : json({ DetalheParlamentar: { Parlamentar: null } }));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

/** A transcript in which each of the first `n` fixture speeches is one turn by its own voice (A, B, ...). */
export function transcriptOfSpeeches(n = FIXTURE_SPEECHES.length, voices = "ABCDE"): Transcript {
  const words: Word[] = [];
  let t = 0;
  FIXTURE_SPEECHES.slice(0, n).forEach((sp, i) => {
    for (const text of stripRecordMarkup(textos[sp.id]!).split(/\s+/).filter(Boolean)) {
      words.push({ text, startMs: t, endMs: t + 300, speaker: voices[i]!, confidence: 0.99 });
      t += 400;
    }
    t += 1000;
  });
  return { language: "pt", languageConfidence: 0.99, durationMs: t, words };
}

export type { RecordSpeech };
