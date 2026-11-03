import { readFileSync } from "node:fs";
import type { Transcript, Word } from "@digestor/core";
import { stripRecordMarkup } from "./align.js";
import { httpTiming } from "./http.js";

httpTiming.delayMs = 0; // tests never wait for the retry

/**
 * Test helpers over the recorded Câmara fixtures (event 82635, the plenary of 2026-06-30, recorded 2026-11-03; shapes
 * as the real API answers, see `camara.ts`). The deputies list is trimmed to 8 (6 who spoke, 2 who didn't) and each
 * `/discursos` answer to 4 speeches. `discursos` is keyed by deputy id.
 */
const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
export const fixtureEvento = fx("camara-evento-82635.json");
export const fixtureDeputados = fx("camara-evento-82635-deputados.json");
export const fixtureDiscursos = fx("camara-discursos-2026-06-30.json") as Record<string, { dados: { dataHoraInicio: string; transcricao: string }[]; links: unknown[] }>;

export const FIXTURE_EVENT_ID = "82635";
export const FIXTURE_DATE = "2026-06-30";
/** The deputies of the fixture who gave speeches that day, in the order of their latest speech (the aligner is monotonic in time), and the two who gave none. */
export const SPEAKER_IDS = ["152605", "204441", "204528", "160575", "74848", "220574"];
export const SILENT_IDS = ["62881", "66385"];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type FakeCamaraOptions = {
  evento?: () => Response | Promise<Response>;
  deputados?: () => Response | Promise<Response>;
  discursos?: (deputyId: string) => Response | Promise<Response>;
};

/** A `fetch` that answers the three Câmara routes from the fixtures; `calls` records every URL. `/eventos/{id}/discursos` answers 405 like the real API. */
export function fakeCamaraFetch(o: FakeCamaraOptions = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace("https://dadosabertos.camara.leg.br/api/v2", "");
    if (/^\/eventos\/\d+$/.test(path)) return (await o.evento?.()) ?? (path.endsWith(`/${FIXTURE_EVENT_ID}`) ? json(fixtureEvento) : json({ status: 404, title: "Not Found" }, 404));
    if (/^\/eventos\/\d+\/deputados$/.test(path)) return (await o.deputados?.()) ?? json(fixtureDeputados);
    if (/^\/eventos\/\d+\/discursos/.test(path)) return new Response("", { status: 405 });
    const m = path.match(/^\/deputados\/(\d+)\/discursos\?/);
    if (m) return (await o.discursos?.(m[1]!)) ?? json(fixtureDiscursos[m[1]!] ?? { dados: [], links: [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

/** A transcript in which each of the first `n` SPEAKER_IDS deputies' first speech is one turn by its own voice (A, B, ...). */
export function transcriptOfDeputies(n = SPEAKER_IDS.length, voices = "ABCDEF"): Transcript {
  const words: Word[] = [];
  let t = 0;
  SPEAKER_IDS.slice(0, n).forEach((id, i) => {
    const speech = fixtureDiscursos[id]!.dados[0]!;
    for (const text of stripRecordMarkup(speech.transcricao).split(/\s+/).filter(Boolean)) {
      words.push({ text, startMs: t, endMs: t + 300, speaker: voices[i]!, confidence: 0.99 });
      t += 400;
    }
    t += 1000;
  });
  return { language: "pt", languageConfidence: 0.99, durationMs: t, words };
}
