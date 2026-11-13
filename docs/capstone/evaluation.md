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

## Ask (RAG)

- **What was measured:** the Ask copilot on two videos, with 12 hand-written questions each (`apps/worker/eval/ask/*.ask.json`; 10 answerable with the transcript spans that answer them, 2 unanswerable; at least 3 per video asked in a different language than the video). Two parts: **retrieval** (does the transcript search put a chunk that overlaps the answer span in the top k; recall@k and mean reciprocal rank, free) and **answers** (the full `runAsk` loop with its tools; `scripts/eval-ask.ts <golden> --answers`).
- **Answer metrics:** citation hit = some cited `[hh:mm:ss]` time (both ends of a range) falls inside an expected span ±30 s, over the answerable questions; quote exact = of the answers that quote text, the share whose quotes all appear verbatim in the transcript; refusal correct = of the unanswerable questions, the share answered with "That isn't in this video's data." (or "I couldn't confirm"; a model that translated the first word still counts). Giving up on the step limit is not a refusal.
- **On what:** Globo second-round presidential debate, Lula × Flávio Bolsonaro (Portuguese, 1 h 57 min, profile `electoral_debate`), questions in Portuguese, English and German; and the Osang × Merkel interview (German, 99 min), questions in German, English and Portuguese. Search: 45 to 60 s chunks, local `multilingual-e5-small`, k = 6.
- **When / model:** 13 November 2026, before the LangGraph, approval and verify changes (the "before" numbers); Ask answered by `anthropic/claude-haiku-5.5` via OpenRouter (the dev machine's provider setup; production Ask uses the configured reasoning model, Sonnet 5.5 by default).
- **Golden files:** drafted by Claude from the transcripts, the owner has not reviewed them yet. The expected spans are approximate (30 to 240 s of the video).
- **Cost:** answers $0.034 (Globo, 43 calls) and $0.022 (Osang, 32 calls) for the table below; retrieval is free. Earlier trial runs of the same script, while its citation parser was being fixed, cost $0.075 more.

| Metric | Globo debate | Osang × Merkel |
| --- | --- | --- |
| Retrieval recall@6 (10 answerable) | 0.80 | 0.70 |
| Retrieval MRR | 0.70 | 0.70 |
| Citation hit | 80% | 100% |
| Quote exact | 100% | 71% |
| Refusal correct (2 unanswerable) | 50% | 100% |
| Answers that gave up on the step limit | 3 of 12 | 0 of 12 |

Reading the table:

- Retrieval misses 5 of the 20 answerable questions: the whisky price and the childcare question in the debate, the Minsk "seven years", the defence budget "32 to 50 billion" and the book question in the interview. All have the right words in a chunk the question's own words don't resemble (a figure, a name), so the embedding ranks other chunks first. The answers still found most of them, because the agent also reads transcript ranges and searches again; that is why citation hit is higher than recall@6.
- The two unanswerable questions ask for things the video never says. Retrieval returns a chunk anyway (top cosine 0.81 to 0.87), so a score threshold would not separate them from real hits; refusal rests on the model. It refused correctly on the interview; on the debate it refused the Mercosul question and gave up on the step limit on the UN question, which is not a wrong claim but not a refusal either.
- The three step-limit failures in the debate (saidinhas, sewage figures, UN) are the loop running out of its 6 steps on a long, repetitive video, where the same topic returns in several blocks. The saidinhas question gave up in both runs; the sewage and UN questions were answered in the earlier trial run, so part of it is sampling noise; 3 of 12 is the number to beat.
- Quote exact: the failures are quotes the model wrote in English or Portuguese about a German transcript (`"order my life again"`, `"se dispersa"`), i.e. a translation presented in quotation marks. The verify step planned in a later task checks those as claims instead.
- 12 questions per video is a small sample: one question moves a percentage by 8 to 10 points, and the model's answers vary from run to run (the interview's citation hit was 20% in a first trial before the parser read time ranges, then 80%, then 100%).
