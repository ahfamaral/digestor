# Câmara monitor: deputy-first navigation, filters, roll-call page — design addendum

Date: 2026-11-11. Status: draft for the owner's approval (rewritten after the owner's review; builder check of the first
draft done). Extends `docs/superpowers/specs/2026-11-11-camara-monitor-preview-design.md` (the preview, merged in
`main` at c742127). Everything there still holds unless this addendum changes it; its anti-goals bind here too:
official records only, no AI text about a person, speeches and votes never shown as if one explains the other, no
rankings or scores.

## Why

Testing the preview, the owner found the search hard to steer: one box mixes names and topics, results look out of date
order with no explanation (they were ranked by match), nothing narrows a topic to a period, a party or a deputy, and a
roll call cannot be opened to see who voted how. Journalists mostly follow a person, and sometimes a topic across the
whole Câmara: the monitor gets one door for each. Demo: Tue 17 Nov.

## 1. Landing page `/monitor`: two doors

Header: title, the year dropdown, the language switch, the data note.

**Door 1, "Find a deputy": a combobox.** Same concept as the location search in the owner's challenge project (a
headless combobox with a styled suggestions panel). Typing opens a panel under the field: header "SUGGESTIONS" with a
count ("3 deputies"), one row per match with photo, name, "PSOL · RS" and a "Not in office now" badge when it applies.
Accent- and case-insensitive, from 2 characters. ↑/↓ moves, Enter or a click **opens that deputy's page at once** (no
Search button). Esc clears the text, a second Esc closes. Panel states: searching, "No deputy matches", an error line
with "Try again". More than 8 matches: "8 shown, keep typing".

**Door 2, "Search a topic across the Câmara".** The topic field (any language, translated, "Searched for: …") and a
Search button, with the cross-deputy filters below it:

- **Show:** ☑ Speeches ☑ Roll calls (both unticked counts as both).
- **Dates:** from / to, within the selected year. Applies to speeches and roll calls.
- **Party (on the day)**, **State (on the day)**, **Session phase**, **Only deputies in office**: speeches only.
- "Clear filters". Nothing searches until Search is pressed; the whole form is one GET, so every view is a link.

Results: Speeches (each row: speaker, their party and state on the day plus "now PL" when it differs, time, phase,
highlighted passage, full text on demand) and Roll calls (bill, date, what was voted, totals; **click opens the roll-call
page**). One **"Best match | Newest first"** switch above the results orders both groups (default Best match); each group
has a count and **Previous / Next** (pt-BR "Anterior" / "Próxima"). The "Deputies" results group is gone (door 1).

## 2. Deputy page `/monitor/deputados/[id]`: the deputy's workspace

- **Header:** photo, name, today's party and state, "Not in office now" when it applies, "Official record" link, the
  year dropdown, the language switch. A small "Find a deputy" combobox to jump to another deputy.
- **Party timeline** for the current legislature (1 Feb 2023 to today), from `/deputados/{id}/historico` (checked
  2026-11-11: dated rows, including "Alteração de partido"; e.g. 220576 Alfredo Gaspar was UNIÃO until 2026-04-29T22:10,
  then PL). One band per party; periods out of office (leave, ministry, end of mandate) as gaps with their official
  description on hover and focus. Desktop: horizontal with year ticks; phone: a short list ("PSOL · since 1 Feb 2023").
  Server-rendered HTML/SVG, no chart library.
- **Positions** from `/deputados/{id}/orgaos?dataInicio=2023-02-01` (checked: 40 rows for 204407; `siglaOrgao`,
  `nomeOrgao`, `titulo`, `dataInicio`, `dataFim`). Leading roles first (any title other than Titular or Suplente:
  Presidente, Vice-Presidente, Relator, Coordenador…) with the body's name and dates, current ones marked "now"; plain
  memberships folded under "Member of N committees". Titles and names as published. Party leaderships ("Líder do …") are
  not included: `/partidos/36839/lideres` (PSOL) was empty on 2026-11-11.
- **Search this deputy's speeches:** a topic field with a switch **Speeches by | Mentioning** (by = their own speeches;
  mentioning = others' speeches that name them, phrase match on their name; dev: 43 such speeches for "Fernanda
  Melchionna"), dates, session phase, the order switch, Previous / Next. The topic is optional in Mentioning. A mention's
  highlighted passage shows the name (and the topic terms when there is a topic), so it is clear why it matched. Party and
  state filters don't apply here (the speaker is fixed in "by"; mentions are filtered by date and phase only).
- **Votes:** their recorded votes, unfiltered, as today; each row opens the roll-call page.

### 2b. More of the official record on the deputy page (owner, 2026-11-11 14:25)

Checked in the open data on 2026-11-11 for 204407. All of it shown as published, with official links; no AI text.

- **Header extras:** profession (`/deputados/{id}/profissoes`: "Bibliotecária") and earlier mandates
  (`/deputados/{id}/mandatosExternos`: "Vereadora · Porto Alegre (RS) · 2009–2018, PSOL"), consecutive terms of the same
  office and place shown as one span.
- **Authored bills and requests:** what the deputy filed since 1 Feb 2026 (`/proposicoes?idDeputadoAutor={id}`; e.g.
  RCP 1/2026, a CPI request on Banco Master/BRB), newest first: type and number, date, ementa, official link. Counts by
  type above the list ("RCP 1 · PL 4 · REQ 12"), a type filter, Previous / Next. Co-authored items included (the
  endpoint returns both), not marked differently unless the data says which.
- **Parliamentary fronts** (`/deputados/{id}/frentes`, current legislature): the titles as a folded list
  ("Member of N parliamentary fronts").
- **Presence in plenary (as a record, never a score):** from the bulk files `eventos-2026.csv` and
  `eventosPresencaDeputados-2026.csv` (checked: 81 closed "Sessão Deliberativa" events in 2026; Melchionna has a presence
  row at 78). Shown as **"Present at 78 of 81 plenary deliberative sessions while in office (2026)"**: only closed
  deliberative plenary sessions held while the deputy was in office (the in-office periods from `/historico`) count. Below
  it, the sessions with **"No presence recorded"** (date, the session's description), never the word "absent", with the
  line "The open data doesn't say why: justified absences, leave and missions look the same." **No percentage, no
  comparison with other deputies, no ranking, no colour.** Presence at a session is not a vote; it is never shown next to
  speeches or votes as if one explained the other.
- **Expenses (cota parlamentar): after the demo, or before if time allows.** The API answered an empty list for 204407
  for 2025 and 2026 on 2026-11-11, and the bulk file is on www.camara.leg.br (not fetched automatically), so the source
  must be settled first.

## 3. Roll-call page `/monitor/votacoes/[id]` (replaces the preview's "no in-app roll-call page")

- Header: the bill (official link), its summary, what was voted, date, totals.
- **By party:** one block per party, **the party at the time of the vote** (published on every row of
  `votacoesVotos-*.csv`, `deputado_siglaPartido`; stored with each vote), with its counts (Sim / Não / Abstenção /
  Obstrução / Artigo 17, as published) and its deputies and their votes; each name opens the deputy page. Parties sorted
  by size; deputies by name.
- **Party and bloc guidance:** the official orientations (`/votacoes/{id}/orientacoes`, also the bulk
  `votacoesOrientacoes-2026.csv`; checked 2026-11-11: 13 rows for 2449741-72) as their own list, since they are given per
  party, bloc, federation or Government/Majority/Minority ("Fdr PT-PCdoB-PV: Sim", "Governo: …"), not per party block.
  Empty orientations are shown as "no guidance".
- Counts and names only: no cohesion, loyalty or other scores.

## 4. Year

A dropdown showing 2026 that opens to the single option "2026" and a muted line "Only 2026 for now"; it scopes the whole
monitor (`year` in the URL; anything else falls back to 2026). 2023–2025 are on the roadmap.

## 5. Prepared for the video link (later)

A future step links an official speech to the stretch of a Digestor session's video where it is spoken (the Câmara
record matcher already aligns official speeches to transcripts for speaker names), so a speech row can say "In your
session at 1:23:45 · Make a clip" with the match's confidence, confirmed by the journalist. Video only through
Digestor's intake; no automated fetching of camara.leg.br video. **Prepared now:** speeches get a **stable key**
(deputy id + `startsAt` + a fingerprint of the text), kept across the nightly window replace, so a later link survives
refreshes. Nothing else of the video link is built now.

## Constraints

Same as the preview (Next 16 server pages, `digestor-ui` rules, `tm()` copy in both languages, Postgres full-text
search). The comboboxes and the year dropdown use **Base UI** (`@base-ui/react` 1.9, already a dependency: `Combobox`,
`Select`) styled with the product's tokens; no new library. Time: build Wed 11 – Thu 12 Nov (about 12 h with §2b),
cut-off Thu night, deploy Fri 13. If the cut-off arrives, drop in this order: parliamentary fronts, the party timeline
and positions (their data is still imported: presence needs the in-office periods), presence, the guidance list on the
roll-call page. Expenses are not in this round unless everything else is done.

## Builder's calls (Claude's, flagged)

- Suggestions from `GET /api/monitor/deputies?q=` (behind the password gate), debounced ~200 ms, at most 8 rows.
- URL parameters on `/monitor`: `q`, `show`, `from`, `to`, `party`, `uf`, `phase`, `inOffice=1`, `sort=new`, `year`,
  `p` (speeches page), `rp` (roll-call page); on the deputy page: `q`, `rel=by|mentions`, `from`, `to`, `phase`, `sort`,
  `p`, `year`. Invalid values are ignored.
- Party and UF on the day: each speech stores the speaker's party and UF at its `startsAt` (the last history row at or
  before it), computed at import. The refresh fetches `/historico` and `/orgaos` per deputy (two more calls each, 4 at
  a time: about 1,100 more at backfill; nightly for every deputy). Existing 2026 speeches are filled by rerunning the
  backfill. Party, State and Phase lists come from the data, sorted alphabetically.
- Votes store the party and UF of the vote row; the guidance comes from the yearly bulk file, refreshed nightly with the
  other vote files.
- Calls per deputy, 4 at a time: `/historico` and authored bills nightly; `/orgaos`, `/frentes`, `/mandatosExternos`
  and `/profissoes` change rarely and are refreshed once a week (Mondays) and whenever missing, so the nightly load stays
  close to today's. Presence comes from the two yearly bulk files, nightly, one file at a time like the vote files.
- Mentions exclude the deputy's own speeches; a name of one word (e.g. "Paulão") is matched as is, which may over-match.

## Done means

- On dev: on `/monitor`, pick "Melchionna" by keyboard and by mouse and land on her page; her timeline and positions
  show; search "feminicídio" by her (best match, then newest), then Mentioning; back on `/monitor`, search "feminicídio"
  across the Câmara, narrow by dates, party on the day, state, phase and in office; open a roll call from the results and
  from her votes and see the votes by party (party at the vote) and the guidance list; her page shows profession, earlier
  mandates, authored bills (filter by type), fronts and "Present at N of M…" with the sessions with no presence recorded;
  the URL reproduces every view;
  both languages; 1280 and 390 px; no console errors.
- Tests: repo filters on a real Postgres (each filter, by vs mentioning, topic optional, dates on roll calls, ordering
  both ways, party on the day vs today), the history-to-party mapping (a switch inside the year), the roll-call page's
  grouping (party at the vote), the stable speech key surviving a window replace, URL parsing (invalid values ignored),
  the suggestions route (min length, limit, shape), message-key parity, presence counting (only closed deliberative
  plenary sessions inside in-office periods; a deputy who joined mid-year), authored bills by type, the weekly profile
  refresh.
