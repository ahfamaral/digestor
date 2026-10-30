# Plan 2: inputs only the owner can give

Written on 2026-10-30, while the owner was away. Nothing here blocks the plan: each item has the default the plan uses. Answer whichever you like. An answer changes only the line it names.

| # | Input needed | Why it matters | Default used in the plan | Where it's used |
|---|---|---|---|---|
| 1 | **API keys** in `.env`: `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY` | Without them every AI step and transcription fails with "`<VAR>` is not set on the server." Development and tests use fakes and the seeded demo session, so the build can proceed. | Build and test with fakes; do a real run only once keys exist | `scripts/smoke.md`, Task 24 |
| 2 | **Golden evaluation set**: one interview (~1 h) and one Câmara or Senado session, hand-labelled with topics, moments per granularity and 2–3 "traps" (a clip cut mid-argument, a quoted opponent) | The capstone needs evaluation results in the README; spec §14a | The script and metrics ship with a small synthetic fixture (`golden-sample.json`); the real numbers wait for your labels. About 2–3 h of your time | Task 24 |
| 3 | **Embedding model** for Ask search | Quality of "what did X say about…" in Portuguese, German and English | Local `Xenova/multilingual-e5-small`: no key and no cost, about 120 MB downloaded once into `data/models`. Alternative: a hosted model such as Voyage or OpenAI, which needs a key and costs money | Task 13 |
| 4 | **Granularity ranges** | How long Exchange, Passage and Punchline moments are | Exchange 2–12 min (accepted 1–20), Passage 30 s–2 min (accepted 20 s–2.5 min), Punchline 8–30 s (accepted 6–45 s). Tune after the first real session | Global Constraints, Task 5 |
| 5 | **Languages offered** for subtitles and briefing translation | Which languages show in the pickers | en, pt, es, fr, de, it, nl, pl, ru, uk, ar, ja, zh, plus the video's own language | Global Constraints |
| 6 | **Vertical (9:16) output size** | File size and quality for social posts | 720×1280 | Task 12 |
| 7 | **Credit line for uploads** | Uploads have no chamber connector to supply one | The YouTube channel name when available; otherwise you type one or tick "No credit needed" | Task 21 |
| 8 | **Stale-session threshold** | When a stuck session is marked failed | 120 minutes without progress and no live job | Task 9 |
| 9 | **Moving your selections after a re-analysis** | A re-run creates new moments; selections on the old ones don't carry over | Not moved. A notice shows how many selections sit on the earlier version; clips already made keep working | Task 20 |
| 10 | **Senado pages check** (needed for Plan 4, not Plan 2) | senate.gov blocked automated checks, and some Senado (Brazil) video and licence details are unverified | None in Plan 2 | Spec §11 |
| 11 | **VPS and domain** for deployment | Needed to deploy anything beyond your laptop | Unchanged from Plan 1 (`docs/deploy.md`) | — |

## Calls made in the plan (no answer needed unless you disagree)

- **Ask runs in the worker as a job.** The page polls for the answer, so expect a few seconds of "Thinking…", not streaming text. This keeps every AI call in the worker, as the project rules require.
- **No i18n library.** A typed English message catalogue with a `t()` helper. Adding Portuguese later means adding one file.
- **Focus** in Plan 2 filters by diarized speaker ("Speaker A"). Real names arrive with Plan 3.
- **"Confirm selection" isn't a lock.** You can go back and change the selection any number of times.
- **Briefing export** is Markdown (`.md`) for now.
