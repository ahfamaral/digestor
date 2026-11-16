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

Reading the table: topics land within about half a minute of the hand-drawn boundaries on average; the checks caught every trap (reported speech and cut-off arguments); the two speakers were named correctly. Passage recall is 0/3 because the analysis cuts this interview into many short passages (93) while the golden passages are whole answers of 80 to 200 seconds, so none is covered by half; this is a granularity mismatch of the labels as much as a miss, and is a point for the owner's review.

## Audio-only run

- **What was checked:** an audio file (no picture) through the whole journalist flow, end to end in the real app; no golden file, a pass/fail walk with Playwright at 1280 and 390 px.
- **On what:** a 10-minute MP3 cut from the Osang × Merkel interview above (10:00 to 20:00, `-vn`, libmp3lame `-q:a 4`, 8 MB), uploaded with `audioOnlyAck=1` and language `de`.
- **When / model / cost:** 13 November 2026; `openrouter:anthropic/claude-haiku-5.5`. Analysis $0.021 (17 calls); context check, 1 Ask question and the moment checks about $0.01 more; transcription about $0.04 (10 min at $0.23/h). Upload to `ready` took about 4 minutes.
- **Result:** works end to end. Upload refuses an MP3 without the acknowledgement (400 with the waveform warning); the session has `has_video = false`, the preview copy is AAC only, and `audio.mp3` is released at `ready`. Processing shows no Naming speakers step; voice samples play on the context check and in Who's who; Briefing rows and the Ask drawer play an audio player (no thumbnail slots on the top highlights); Prepare plays audio, explains 9:16 ("the export shows a waveform in this shape"), and the subtitle editor follows the audio; renders are a white waveform on a dark background, 1280×720 or 720×1280, with the credit line and burned-in subtitles; "Download all" zips the plain MP4s, SRT and VTT. No console errors.
- **Fixed during the run:** Processing said "Preparing the video for playback" (now "the audio" for an audio file); context-card facts said "from video" (now "from audio"); the Ask drawer said "Ask about this video" (now "this recording"); and, for every session, an Ask answer citing a range `[00:04:09–00:05:06]` had no play button (ranges now play from their start, and lists `[a; b]` get a button per time).

## Ask (RAG)

- **What was measured:** the Ask copilot on two videos, with 12 hand-written questions each (`apps/worker/eval/ask/*.ask.json`; 10 answerable with the transcript spans that answer them, 2 unanswerable; 7 per video asked in a different language than the video). Two parts: **retrieval** (does the transcript search put a chunk that overlaps the answer span in the top k; recall@k and mean reciprocal rank, free) and **answers** (the full `runAsk` loop with its tools; `scripts/eval-ask.ts <golden> --answers`).
- **Answer metrics:** citation hit = some cited `[hh:mm:ss]` time (both ends of a range) falls inside an expected span ±30 s, over the answerable questions; quote exact = of the answers that quote text, the share whose quotes all appear verbatim in the transcript; refusal correct = of the unanswerable questions, the share answered with "That isn't in this video's data." (or "I couldn't confirm"; a model that translated the first word still counts). Giving up on the step limit is not a refusal.
- **On what:** Globo second-round presidential debate, Lula × Flávio Bolsonaro (Portuguese, 1 h 57 min, profile `electoral_debate`), questions in Portuguese, English and German; and the Osang × Merkel interview (German, 99 min), questions in German, English and Portuguese. Search: 45 to 60 s chunks, local `multilingual-e5-small`, k = 6.
- **When / model:** 13 November 2026, before the LangGraph, approval and verify changes (the "before" numbers); Ask answered by `anthropic/claude-haiku-5.5` via OpenRouter (the dev machine's provider setup; production Ask uses the configured reasoning model, Sonnet 5.5 by default).
- **Golden files:** drafted by Claude from the transcripts, the owner has not reviewed them yet. The expected spans are approximate (30 to 240 s of the video).
- **Cost:** answers $0.034 (Globo, 43 calls) and $0.022 (Osang, 32 calls) for the table below; retrieval is free. Earlier trial runs of the same script, while its citation parser was being fixed, cost $0.075 more.

| Metric | Globo debate, before | Globo debate, after C1+C2 | Osang × Merkel, before | Osang × Merkel, after C1+C2 |
| --- | --- | --- | --- | --- |
| Retrieval recall@6 (10 answerable) | 0.80 | 0.80 | 0.70 | 0.70 |
| Retrieval MRR | 0.75 | 0.75 | 0.70 | 0.70 |
| Citation hit | 80% | 90% | 100% | 80% |
| Quote exact | 100% | 100% | 71% | 100% |
| Refusal correct (2 unanswerable) | 50% | 100% | 100% | 50% |
| Answers that gave up on the step limit | 3 of 12 | 1 of 12 | 0 of 12 | 1 of 12 |
| Answers sent back by verify | – | 1 of 12 | – | 1 of 12 |
| Answers ending "I couldn't confirm" | – | 0 of 12 | – | 0 of 12 |
| Answers with parts the judge couldn't check | – | 0 of 12 | – | 2 of 12 |

q08 was reworded after this baseline run (it named the wrong speaker); the 'after' run uses the new wording. Retrieval was re-run with the new wording (Globo MRR 0.70 became 0.75, recall unchanged); the 'before' answer rows are from the baseline run.

**After C1+C2** (13 November 2026, same model and goldens): Ask runs as the LangGraph graph with approval before changes (C1) and the verify step (C2: quotes checked word for word against the whole transcript, cited sentences judged by one fast-model call on the transcript ±45 s around each cited time, at most 2 retries, then an "I couldn't confirm: …" line). Cost of the two 'after' runs: $0.038 (Globo, 54 calls) and $0.035 (Osang, 50 calls), judge calls included; a first 'after' run ($0.082) found that corrected answers talked about the check ("I've corrected my earlier quote"), so the retry message now says the user never saw the earlier answer. For the second run the judge prompt counted "X isn't mentioned here" as supported when the passage didn't mention X; since then the judge marks such absence claims "unclear" (not checked), because a ±45 s window can't prove that something is absent from the whole video. The numbers above are from the second run.

- Quote exact stayed at 100% on the Globo debate and rose to 100% on the interview, but the metric checks quotes literally: verify treats a quote whose words mostly aren't in the transcript (an English or Portuguese rendering of German speech) as a translation and judges it as a claim, so it no longer sends those back; in this run the model simply quoted the original words. In the first 'after' run, translated quotes stayed and verify passed them as supported claims (the literal metric still counted them as not found).
- Verify sent back 1 answer per video, and each corrected answer passed; no answer ended with "I couldn't confirm". In the first 'after' run 3 Globo answers ended with it, two of them because the answer had already used its 6 steps (verify then keeps the answer with the line instead of asking again).
- The changes in citation hit, refusal and step-limit rows (Globo better; Osang worse: q02 answered that the video doesn't say why she chose the Baltic and cited the passage around 00:14:25 instead of the reasons at 00:17:20, q06 quoted a later "7 Jahre" passage at 00:55:46 that the golden doesn't list, and q12 gave up on the step limit instead of refusing; none of these answers was sent back by verify) are within the run-to-run variation described below; with 12 questions per video one question moves a rate by 8 to 10 points. Verify doesn't touch refusals or the step limit: it skips "That isn't in this video's data." and the step-limit line.

**Re-run, 16 November 2026** (same model, goldens and graph, after the "I couldn't confirm" line was shortened and the Ask-across-videos prompt changed; neither touches these single-video answers' logic): Globo citation hit 80%, quote exact 100%, refusal correct 50%, gave up on the step limit 2 of 12, sent back by verify 0 of 12 ($0.041, 53 calls); Osang citation hit 100%, quote exact 63%, refusal correct 100%, gave up 0 of 12, sent back 1 of 12, 2 answers with parts the judge couldn't check ($0.033, 46 calls). Retrieval unchanged (0.80 / 0.75 and 0.70 / 0.70). Every row moved within the one-question-per-8-to-10-points band again; Osang's quote-exact drop is translated quotes in English and Portuguese answers about German speech, which verify judges as claims (all passed), so the literal metric counts them as not found.

Reading the table:

- Retrieval misses 5 of the 20 answerable questions: the whisky price and the childcare question in the debate, the Minsk "seven years", the defence budget "32 to 50 billion" and the book question in the interview. All have the right words in a chunk the question's own words don't resemble (a figure, a name), so the embedding ranks other chunks first. The answers still found most of them, because the agent also reads transcript ranges and searches again; that is why citation hit is higher than recall@6.
- The two unanswerable questions ask for things the video never says. Retrieval returns a chunk anyway (top cosine 0.81 to 0.87), so a score threshold would not separate them from real hits; refusal rests on the model. It refused correctly on the interview; on the debate it refused the Mercosul question and gave up on the step limit on the UN question, which is not a wrong claim but not a refusal either.
- The three step-limit failures in the debate (saidinhas, sewage figures, UN) are the loop running out of its 6 steps on a long, repetitive video, where the same topic returns in several blocks. The saidinhas question gave up in both runs; the sewage and UN questions were answered in the earlier trial run, so part of it is sampling noise; 3 of 12 is the number to beat.
- Quote exact (before): the failures are quotes the model wrote in English or Portuguese about a German transcript (`"order my life again"`, `"se dispersa"`), i.e. a translation presented in quotation marks. The verify step (C2) checks those as claims instead.
- 12 questions per video is a small sample: one question moves a percentage by 8 to 10 points, and the model's answers vary from run to run (the interview's citation hit was 20% in a first trial before the parser read time ranges, then 80%, then 100%).

## Monitor search

- **What was measured:** the Câmara monitor's topic search over plenary speeches, three ways: **words** (Postgres full-text on `pt_unaccent`, as the site runs it: the query translator's Portuguese terms, multi-word terms as phrases, the typed words together ranked first), **meaning** (the speeches' official text in chunks of whole sentences up to 1,000 characters, embedded with the local `multilingual-e5-small` into Chroma; best chunk per speech) and **hybrid** (Reciprocal Rank Fusion, k = 60, of the top 100 of each: what `/monitor` now shows under "Best match"). Recall@10 and MRR@10 per query (`apps/worker/scripts/eval-monitor-search.ts`).
- **On what:** 7,899 speeches of 2026 with text or summary (23,460 chunks); 20 queries (`apps/worker/eval/monitor-search.golden.json`): 14 in Portuguese, several worded unlike the speeches ("aumento do preço da comida", "aposentados roubados por descontos indevidos", "perdão para os condenados pelos atos de 8 de janeiro"), and 6 in English.
- **Golden file:** labelled by the coding agent (Claude) reading the pooled texts, not an automated LLM judge (no labelling calls); owner review pending. For each query the top 10 of the three methods were pooled and each pooled speech's official summary, opening and term counts in the full text were read; relevant = the speech is about the topic, not a passing mention in a list. The pool includes each method's own top 10, hybrid's too, so a speech only hybrid ranked can be relevant (q11's only relevant speech was found only by hybrid). Paired queries (the same topic in Portuguese and English) share their relevant speeches. Speeches are identified by deputy, start minute and session phase (plus an ordinal when the same deputy has several speeches in that minute and phase: 99 such groups in dev), not by key, because a speech's key changes when the Câmara revises its text; recall counts distinct relevant speeches.
- **When / cost:** 13 November 2026 (re-run after the identity fix: same numbers). The translator's terms for the 20 queries were fetched once (OpenRouter, about $0.001) and frozen in the golden file, so the evaluation itself is free and repeatable.

| Subset | Queries | Words recall@10 | Meaning recall@10 | Hybrid recall@10 | Words MRR | Meaning MRR | Hybrid MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| All | 20 | 0.41 | 0.53 | **0.61** | 0.66 | 0.82 | **0.87** |
| Portuguese | 14 | 0.40 | 0.58 | **0.66** | 0.62 | 0.78 | **0.82** |
| English | 6 | 0.41 | 0.41 | **0.49** | 0.75 | 0.92 | **1.00** |

Reading the table:

- Hybrid beats words on recall@10 on 12 queries, ties on 6 and loses on 2 (q07 "vício em apostas online", 0.42 vs 0.47; q15 "food prices", 0.50 vs 0.63), so it is the default; exact words (`exact=1`), "Newest first" and a deputy's own speech search stay word-only.
- Meaning helps most where the speeches use other words: "perdão para os condenados pelos atos de 8 de janeiro" (words 0.00, the phrase terms never match; meaning finds the dosimetria and 8 January speeches), "agricultores sofrendo com a falta de chuva" (words 0.00, meaning 1.00) and "end of the six-day work week" (the translator wrote "semana de trabalho de seis dias", which no speech says; words 0.00, meaning 0.37 by matching "escala 6x1").
- Meaning hurts on broad cost-of-living queries: for "food prices" and "aumento do preço da comida" it ranks fuel-price and economy speeches above food ones (meaning 0.25 and 0.13); fusion keeps most of the word results there.
- Recall is low in absolute terms because the relevant sets are large (up to 27 speeches for the 6x1 work week) and only 10 results count. Four queries have 1 to 3 relevant speeches in the pool (q04, q08, q11, q13), so one speech moves their recall by 0.33 to 1.00. Pooling only finds what one of the three methods ranked in its top 10, so the relevant sets miss speeches none of them surfaced; that limits all three methods alike.
- Rows only the meaning search found carry a quiet "Close in meaning" mark, are counted apart from the word matches ("plus N close in meaning") with a note that they may not be about the topic, and show the official summary instead of highlighted words; with no word match at all (a gibberish query still has nearest neighbours) the page says "No speech uses these words. Closest by meaning (may be unrelated):"; when the worker doesn't answer within 3 s the page shows word results and "Search by meaning isn't available right now".

### A deputy's vote and bill text boxes

- **What was measured:** the deputy page's two other text boxes, searched three ways over *that deputy's own records only* (as the page runs them): **words** (full text on `pt_unaccent` with the translator's terms and the typed-phrase boost, best match first), **meaning** (each roll call's bill label + summary + what was voted, and each signed bill's label + summary, embedded with the same local e5 model in their own Chroma collections; the deputy's records scored against the query, unfiltered top 10) and **hybrid** (what the page shows: the word matches first, in RRF order (k = 60) with the closest meaning hits so a word match the meaning search also found rises; then the hits only the meaning search found, at most 10 and within 0.03 of the best one, marked "Close in meaning" and counted apart from the matches). Recall@10 and MRR@10 (`apps/worker/scripts/eval-monitor-records.ts`).
- **On what:** 8 queries with relevant records plus 2 null queries (`apps/worker/eval/monitor-records.golden.json`), 4 on votes (Sargento Fahur, 125 of the 126 roll calls of 2026) and 4 on bills (Laura Carneiro 1,118 bills, Sargento Portugal 2,080, Pedro Uczai 644); 4 in Portuguese, 4 in English.
- **Golden file:** labelled by the coding agent (Claude) reading the official texts, not an automated LLM judge (no labelling calls); owner review pending. Votes: every one of the deputy's 125 roll calls was read, so the relevant sets are complete. Bills: the pooled top 10 of the three methods plus every bill of the deputy whose summary holds one of the topic's stems were read. Relevant = about the topic itself (a ceremonial session or an honour motion is not; a request for urgency or information on a relevant bill is). Translator terms frozen in the file, so the run is free.
- **When / cost:** 13 November 2026; the 8 translations once (OpenRouter, well under $0.01).

| Subset | Queries | Words recall@10 | Meaning recall@10 | Hybrid recall@10 | Words MRR | Meaning MRR | Hybrid MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| All | 8 | 0.31 | 0.80 | **0.74** | 0.75 | 1.00 | **0.94** |
| Votes | 4 | 0.41 | 0.90 | **0.82** | 0.75 | 1.00 | **1.00** |
| Bills | 4 | 0.21 | 0.70 | **0.65** | 0.75 | 1.00 | **0.88** |

Reading the table:

- The words miss most of these: official summaries rarely use a reader's words ("harsher punishment for criminals": words 0.00, the bills say "aumentar as penas" and "crime hediondo"; "cancer treatment": words 0.00, the bills say "inibidores de CDK 4/6" and "câncer de mama"). Hybrid more than doubles recall@10 (0.31 to 0.74).
- Meaning alone scores higher than hybrid here, but it is a ranking of *all* the deputy's records: it always fills ten rows, relevant or not. e5's cosine scores bunch between about 0.75 and 0.9 whatever the query ("receita de bolo de chocolate" scores 0.855 against a vote on cocoa products), so no fixed floor separates related from unrelated. The cut was chosen with `--sweep` on the same 8 queries (so it is tuned, not tested, on them): "within 0.03 of the best hit" kept the recall of a 0.8 floor (0.74) at a higher precision@10 (0.71 against 0.59), and follows English queries, which score lower than Portuguese ones.
- **Null queries** (no relevant record, checked by reading): "aposentadoria" on Sargento Fahur's votes (no 2026 roll call is about pensions) and "space missions to Mars" on Pedro Uczai's 644 bills. Both show 0 word matches and 10 false positives close in meaning (for "aposentadoria": social-assistance funding, unemployment insurance, tax-benefit rules). That is why those rows are worded as they are: the count line says "0 of 125 recorded votes · plus 10 close in meaning", the list opens with "No vote uses these words. Closest by meaning (may be unrelated):", each row carries "Close in meaning", and with word matches they always come after the last one ("Exact words only" turns meaning off and keeps the word rank, best first). No cut in the sweep removes them without losing recall: a fixed 0.8 floor halves them (10 instead of 20 over the two queries) at the cost of precision on the others.
- Small set, one labeller, and the cut tuned on it: read the numbers as "meaning finds what the words miss in official summaries", not as a precise estimate.

