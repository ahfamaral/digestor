# Evaluation results

Evaluation results for the capstone; each section says what was measured, on what, when, with which model, and the cost.

## Interview: Osang × Merkel

- **What was measured:** the analysis of one long interview against a hand-labelled golden file (`apps/worker/eval/osang-merkel-2022-06-07.golden.json`): topic boundaries, moment recall per granularity, highlight types, the check warnings on traps, and who-speaks-when (`scripts/eval.ts --run-checks`).
- **On what:** "Was also ist mein Land?": Alexander Osang interviews Angela Merkel (former chancellor), Berliner Ensemble, 7 June 2022, phoenix broadcast (https://www.youtube.com/watch?v=hiwnD00kV0w). German, 99 minutes, profile `interview`.
- **When / model:** 13 November 2026; analysis version 1 and the checks run with `openrouter:anthropic/claude-haiku-5.5` (the provider setup of the dev machine).
- **Golden file:** 12 topics, 14 moments (9 exchanges, 3 passages, 2 punchlines), 8 traps (4 `quoted_opponent`, 4 `mid_argument`), 149 speaker turns (about 90 minutes, announcer stretches left out). Drafted by Claude from the transcript; the owner has not reviewed it yet.
- **Cost:** analysis $0.145 (79 calls, $0.088 per hour of video), checks $0.015 (28 calls); transcription by AssemblyAI for about 99 minutes (estimated $0.25 to $0.61 depending on the tier, not metered by the app).

| Metric | Result |
| --- | --- |
| Topic boundary error, mean | 31.2 s |
| Topic boundary error, max | 116.8 s |
| Moment recall, exchange | 6/9 (67%) |
| Moment recall, passage | 0/3 (0%) |
| Moment recall, punchline | 2/2 (100%) |
| Highlight type matched | 7/14 |
| Check warnings fired on traps, mid_argument | 4/4 |
| Check warnings fired on traps, quoted_opponent | 4/4 |
| Moments found (exchange / passage / punchline) | 24 / 93 / 130 |
| Speaking time named correctly (AI only and as stored) | 4351.5 s (100%) |
| Speaking time named wrongly / unnamed | 0.0 s / 0.0 s |
| Attribution score | 1.00 |
| LLM cost, analysis | $0.145 · 79 calls |
| LLM cost, checks run now | $0.015 · 28 calls |

Reading the table: topics land within about half a minute of the hand-drawn boundaries on average; the checks caught every trap (reported speech and cut-off arguments); the two speakers were named correctly. Passage recall is 0/3 because the analysis cuts this interview into many short passages (93) while the golden passages are whole answers of 90 to 200 seconds, so none is covered by half; this is a granularity mismatch of the labels as much as a miss, and is a point for the owner's review.
