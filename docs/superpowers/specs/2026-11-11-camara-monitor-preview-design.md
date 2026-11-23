# Câmara monitor preview — design

Date: 2026-11-11. Status: draft for the owner's approval. First slice of the parliament monitor
(its design lives in private research notes), built inside Digestor for the capstone demo on Tue 17 Nov 2026.

## Why

The owner wants Digestor to grow into a parliament monitor for Brazilian journalists and researchers. The demo is the
first time an audience sees it. The one thing it must show: **search a deputy and see their speeches and votes**, and
find what a deputy said about a topic inside the speeches themselves, in any language.

Demo script (the owner's): search "Fernanda Melchionna" (PSOL-RS, Câmara id 204407), open her page, see her 2026
speeches and roll-call votes; search a topic: "feminicídio", and the same in English ("femicide"), and land on her
speeches about it. Checked on 2026-11-11 in the open data: 48 speeches since 1 Feb 2026 (7 on violence against
women / feminicide, the Câmara's own keywords), and roll calls with her votes.

## Goals

1. **Deputy search** by name (accent- and case-insensitive, partial names).
2. **Deputy page**: name, party, state, photo (the Câmara's URL), then two lists, newest first:
   - **Speeches**: date and time, the session phase (`faseEvento.titulo`, e.g. "Breves Comunicações"), the Câmara's
     summary (`sumario`), and the full official text (`transcricao`) on demand (expand in place).
   - **Votes**: one row per plenary roll call: date, the bill (e.g. "PLP 281/2019") and its official summary (ementa),
     what was voted (`descricao`), and the deputy's vote as published (Sim, Não, Abstenção, Obstrução, Art. 17).
3. **Topic search** over the text of all speeches **and** over the roll calls (the bill's ementa and the vote's
   description). Results in two groups, Speeches and Roll calls, each with the deputy (for speeches), date, a snippet
   with the matched words highlighted, and a link to the deputy page or the roll call. Roll-call results show the
   bill, what was voted and the totals, never an individual deputy's vote. On a deputy page, a search box searches
   **that deputy's speeches only**; their votes stay in their own unfiltered list (owner's decision, 2026-11-11).
   Reason, from the real data: on 18 Mar 2026 Melchionna's "Não" on a procedural request about PL 3880/2024 (a bill
   she co-authored, under obstruction) would read, next to her feminicide speeches, as a vote against it.
4. **Search in any language.** The query is translated into Portuguese search terms by a small LLM call (Haiku 5.5
   via OpenRouter, the provider Digestor already uses), then searched with Postgres full-text search. The page always
   shows what was searched: "Searched for: feminicídio (from "femicide")". A Portuguese query goes through unchanged.
5. **Two interface languages**, English and Portuguese (Brazil), with a switch on the monitor pages. Default from the
   browser's language (pt → Portuguese, anything else → English); the choice is remembered in a cookie. Official data
   (speech text, summaries, ementas, vote labels) is shown as published, in Portuguese, in both interface languages.
6. **Official links.** Each deputy, roll call and bill links to its public page on camara.leg.br.
7. **Data**: the current legislature's deputies, every plenary speech and every plenary roll call from **1 Feb 2026**
   (start of the legislative year) to today. A nightly job brings it up to date.

## Non-goals (not in the preview)

- Ask templates, the 7-day reply process, structured problem flags, nightly data-quality checks.
- Senado, committees, other parliaments; video and "trechos" (no automated fetching of trecho URLs: robots.txt
  disallows them and the design requires the Câmara's written agreement first).
- Any pairing of a speech with a vote ("said X, voted Y"), presence statistics, rankings or scores.
- The rest of Digestor in Portuguese (after the demo, about one day of work).
- Semantic / vector search (pgvector). Only if full-text search proves to miss things.
- Public access: everything stays behind `APP_PASSWORD` like the rest of Digestor.

## Anti-goals (would make it a failure even if it works)

- Any sentence written by AI about a named person. The only AI step is translating the search query; results are
  always the official text.
- Speeches and votes shown side by side as if one explains the other.
- Breaking or slowing the Digestor flow that the demo presents (upload → briefing → clips). The monitor is separate
  pages and separate tables; the AppBar gets one more entry.
- Hammering the Câmara's API (it answers 200 with empty arrays when it breaks, and has no SLA).

## Constraints

- **Time:** build Wed 11 – Thu 12 Nov; cut-off Thu night; deploy to prod Fri 13 Nov, then rehearsal 14–16 Nov. If the
  cut-off arrives, the language switch and query translation are the parts to drop; the core (search, deputy page,
  speeches, votes) must not depend on them.
- **Server:** Hetzner CX23 (2 vCPU, 4 GB RAM, 40 GB disk). The data is text: tens of MB.
- **Stack and conventions:** Digestor's (CLAUDE.md): Drizzle tables and repo functions in `packages/core`, a new
  migration (0022), worker jobs on pg-boss with `JOB_OPTIONS`, screens in `apps/web` following the `digestor-ui` skill,
  `t()` messages in `apps/web/messages`. Structured LLM output follows the `llm-structured-output` skill; the
  Câmara client and fixtures follow `vendor-contract-check`.

## Sources (checked 2026-11-11)

| Data | Source | Notes |
|---|---|---|
| Deputies | `GET /deputados` (current legislature, 57) or `arquivos/deputados/csv/deputados.csv` | id, name, party, UF, photo URL |
| Speeches | `GET /deputados/{id}/discursos?dataInicio&dataFim&itens=100` (paged via `links` rel next) | No bulk file. `transcricao` (full text, can be empty until transcribed), `sumario`, `keywords`, `faseEvento.titulo`, `tipoDiscurso`, `dataHoraInicio` (a 4-minute block). `urlTexto`, `urlVideo`, `uriEvento` are empty/null. Digestor's `records/camara.ts` already calls this endpoint. |
| Roll calls | bulk `arquivos/votacoes/csv/votacoes-2026.csv` (5 MB) filtered to `siglaOrgao = PLEN` | id, date, `descricao`, totals, `ultimaApresentacaoProposicao_idProposicao` |
| Votes | bulk `arquivos/votacoesVotos/csv/votacoesVotos-2026.csv` (18 MB) | one row per deputy per roll call: `voto`, deputy id |
| Bill per roll call | bulk `votacoesObjetos-2026.csv` (15 MB) and/or `proposicoes-2026.csv` (44 MB) | bill type/number/year and ementa. Bills from earlier years are voted too, so a missing ementa is fetched once with `GET /proposicoes/{id}`. |

The bulk files are regenerated nightly (last-modified 04:00–07:10 UTC on 2026-11-11), CSV with `;` and a BOM.
Most plenary votações are symbolic and have no per-deputy votes; only roll calls do (5 of 123 checked Sep–Nov 2026,
an election-season low).

## Decided (with the owner)

- Search a deputy, then see their speeches and votes (the demo's core).
- Topic search inside speeches, and also over roll calls on bills about the topic.
- A deputy page's search covers their speeches only, not their votes (option (a), 2026-11-11).
- Interface in English and Portuguese (Brazil) with a switch; search in any language through query translation.
- Brazil (Câmara) only. Tables shaped so that another house could be added later (a `house` column), not built now.

## Builder's calls (Claude's, flagged for the owner)

- Period from 1 Feb 2026, not "the last 2–3 weeks": the plenary barely met in the election months, so the demo
  deputy's page would be nearly empty otherwise.
- Full-text search: Postgres `portuguese` configuration with `unaccent`, a stored `tsvector` per speech (summary +
  text, summary weighted higher) and per roll call (ementa + description), ranked with `ts_rank`, snippets with
  `ts_headline`. Names: `unaccent` + `ILIKE`/trigram on the name.
- Query translation: one structured call returning **a few Portuguese search terms** (the direct translation plus up
  to 3 close terms, e.g. "femicide" → feminicídio, violência contra a mulher, assassinato de mulheres), combined with
  OR in the full-text query; lenient schema, a cap on length, cached per query. All terms are shown in "Searched
  for". This gives part of the benefit of meaning-based search for about 15 minutes of work; vector search
  (pgvector, reusing Digestor's multilingual-e5-small embedder) comes after the demo, measured with eval B (owner
  approved, 2026-11-11). On any failure the search runs on the query as typed and says so. Queries are capped at 200 characters.
  Where the call runs (web route calling OpenRouter directly, or a worker job) is the builder's choice; the web app
  has no LLM code today.
- Nightly job `monitor.refresh` scheduled after the bulk files are regenerated (around 09:00 UTC), refreshing the
  last 7 days of speeches (late transcriptions) and the year's roll-call files; a one-off backfill script for
  1 Feb onward. Upserts, so reruns are harmless. API calls at most 4 at a time, like the existing Câmara client.
- "No vote recorded" rather than "absent": the data does not say why (justified absences, leave, role).
- **One search box** on `/monitor`. Deputies matching the raw query by name show first; Speeches and Roll calls
  come from the translated terms. Names are kept as typed by the translation prompt.
- **No in-app roll-call page.** A roll call links to its bill's public page,
  `https://www.camara.leg.br/propostas-legislativas/{idProposicao}` (checked 2026-11-11: answers 200, redirecting to
  the bill's tramitação page). A roll call with no bill gets no link.
- **Roll calls in search: only roll calls** (votações with per-deputy votes, 126 of 1,575 plenary votações in 2026),
  not symbolic votes. "Feminicídio" / "violência contra a mulher" matches 5 roll calls in 2026 (builder check).
- **Deputies:** everyone who sat in the 57th legislature during 2026 (alternates and returning ministers included), so
  their speeches and vote rows have a name; marked "Not in office now" when they are not in `GET /deputados` today.
- **Votes list: recorded votes only**, with one muted line saying roll calls without a recorded vote are not listed.
  Showing "No vote recorded" for every roll call would read as absences for someone who joined mid-year, and mandate
  dates would cost a fetch per deputy. (This replaces the "No vote recorded" rows in goal 2.)
- Speech links: the data has no per-speech URL. The builder finds the best public page (for example the deputy's page
  on camara.leg.br) and checks it by hand; no link is better than a wrong one.

## Left to the builder

Table and column names, page layout within the `digestor-ui` rules, pagination, ranking weights, how much of a
speech shows before "Show full text", the exact messages in both languages (Portuguese reviewed by the owner).

## Done means

- On prod, behind the password: "Fernanda Melchionna" finds her; her page lists her 2026 speeches and roll-call votes
  with official links; "feminicídio" and "femicide" both find her speeches on it, and roll calls on related bills.
- The switch changes every monitor label between English and Portuguese; Digestor's own screens are unchanged.
- The nightly job ran at least once on prod and its counts are in the worker log.
- Tests: Câmara client mapping on recorded fixtures (speeches, the three CSVs, a proposição), the search queries on a
  real Postgres (accents, ranking, deputy filter), query translation (Portuguese passthrough, translation, failure
  fallback), message-key parity between the two catalogues.

## Notes for the demo

- One speech filed under Melchionna on 17 Mar 2026 (18:00) begins "O Deputado": probably another deputy's speech,
  filed under her id by mistake. The preview shows records as published; avoid opening that one on stage.
- Which of a roll call's many objects is "the bill": `votacoesObjetos` lists requests, amendments, opinions and the
  bill itself for one votação. The builder picks the main bill (the PL/PLP/PEC/MPV the requests refer to, or
  `ultimaApresentacaoProposicao_idProposicao`) and tests it on 2449741-72 (PL 2942/2024) and 2462009-57
  (PL 3880/2024).
