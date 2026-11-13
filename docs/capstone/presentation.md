# Capstone presentation outline

Ten minutes plus five minutes of questions, for the Turing College capstone review (Wed/Thu 18–19 Nov 2026). Structure: SCR (situation, complication, resolution) across the six required points: problem, solution, data, evaluation, challenges, what's next. Digestor is the capstone; the Câmara monitor is shown as the extension and the next step.

Every number below comes from `docs/capstone/evaluation.md`, the README's Evaluation and Ethical considerations sections, or the monitor roadmap (`reports/src/report-en.html`, local). Where a number is not there yet, the slide has a marked placeholder.

## Timing

| # | Slide | SCR | Required point | Time | Clock |
|---|---|---|---|---|---|
| 0 | Title | | | 0:15 | 0:15 |
| 1 | Hours of video, minutes of news | Situation | Problem | 0:45 | 1:00 |
| 2 | Why a summary isn't enough | Complication | Problem | 0:45 | 1:45 |
| 3 | The AI proposes, the journalist decides | Resolution | Solution | 0:45 | 2:30 |
| 4 | Demo: one interview to one clip | Resolution | Solution | 1:30 | 4:00 |
| 5 | How the AI is built | Resolution | Solution (learning application) | 1:00 | 5:00 |
| 6 | The data | | Data | 0:45 | 5:45 |
| 7 | Evaluation: the analysis and the names | | Evaluation | 1:00 | 6:45 |
| 8 | Evaluation: Ask and search | | Evaluation | 1:00 | 7:45 |
| 9 | Risks and safeguards | | Ethics | 0:45 | 8:30 |
| 10 | What was hard | | Challenges | 0:45 | 9:15 |
| 11 | What's next | | What's next (SMART) | 0:45 | 10:00 |

If the clock runs over, shorten slide 4 (show three screens instead of six) and slide 10 (one challenge instead of three).

---

## Slide 0. Title

- **Message:** Digestor: long public-interest videos to checked, subtitled clips.
- **Visual:** project name, one line "Debates, hearings, parliaments and interviews, cut into clips a journalist can stand behind", your name, the showcase link.
- **Speaker notes (15 s):** "I built Digestor, a tool for journalists who have to turn a two-hour debate or interview into a few clips they can publish. I'll show the problem, the product, how I measured it, what went wrong, and where it goes next."

## Slide 1. Situation: hours of video, minutes of news

- **Message:** Long political and interview videos hide a few minutes that matter, and finding them is slow manual work.
- **Visual:** a timeline bar of the Globo presidential debate (1 h 57 min) with a few short marks on it; beside it the steps a journalist does by hand: watch, note times, cut, transcribe, translate, subtitle, credit.
- **Numbers:** Globo debate 1 h 57 min; Osang × Merkel interview 99 min; Senado plenary 5 h 19 min.
- **Speaker notes (45 s):** "A second-round presidential debate runs two hours. A Senate plenary runs five. A journalist needs maybe three clips from it, each a minute long, subtitled, with a credit, and correct: the quote has to mean what the speaker meant. Today that means scrubbing through the video, writing down times, cutting in an editor and typing subtitles. For a foreign-language source it also means translating. It is hours of work for minutes of output, and it happens every week in every newsroom that covers politics."

## Slide 2. Complication: why a summary isn't enough

- **Message:** A generic AI summary doesn't solve this: a clip is published under a person's name, so the errors that matter are a quote out of context, a wrong name on a voice, and a cut in the middle of a sentence.
- **Visual:** three short examples side by side: "a speaker quoting an opponent", "an argument cut before its 'but'", "the chair's line attributed to a senator". Each labelled with the check that now catches it.
- **Numbers:** none on this slide (they come on slides 7 and 8).
- **Speaker notes (45 s):** "The obvious answer is 'ask an LLM for the highlights'. That fails in three ways that matter for journalism. A model can pick a moment where the candidate is quoting his opponent, and the clip makes him say the opposite. It can end a clip before the 'but' that changes the argument. And it can put the wrong name on a voice, which puts words in the wrong mouth. On top of that the sources are multilingual: Portuguese, German, English. So the problem is not summarising; it is proposing moments a human can check quickly and trust."

## Slide 3. Resolution: the AI proposes, the journalist decides

- **Message:** Digestor does the first pass and leaves every decision to a human, with checks at each step.
- **Visual:** the stepper as a flow: Upload › Processing › Context › Briefing › Prepare › Export. Mark the human steps (Context check, Approve/Skip, Prepare, approve subtitles) in one colour and the AI steps in another.
- **Numbers:** 7 profiles (parliament, supreme court, electoral debate, trial, interview, UN, other); moments at 3 scales (exchange, passage, punchline).
- **Speaker notes (45 s):** "You upload a file or paste a YouTube link. The audio is transcribed with speaker labels. A context agent works out what kind of event it is and asks you only what it can't tell, up to three questions. Then the analysis: topics, moments at three scales, exchanges, passages and punchlines, with highlight types that fit the profile, and a briefing whose quotes are checked word for word against the transcript. You approve or skip moments, trim clips that snap to sentence boundaries, add translated subtitles you can edit, and export MP4, SRT and VTT. Nothing is exported without a human approving it."

## Slide 4. Demo: one interview to one clip

- **Message:** the full flow on a real video in about 90 seconds.
- **Visual:** live on https://digestor.freitasdoamaral.com, or the showcase video as fallback. Screens in order (showcase shot list numbers): Sessions (1), Briefing top (5), topic card with moment tree (6), Ask answer (8) and approval card (9), Prepare (10), Export (12). Use the Osang × Merkel interview (German) or the Globo debate.
- **Numbers:** none; let the screens speak.
- **Speaker notes (1:30):**
  - "This is the Sessions page: each video and where it is."
  - "The Briefing page for the Merkel interview: a summary on top, then one card per topic. Inside each topic, the moment tree: exchanges, passages, punchlines. Each AI highlight says why it was picked; counted ones, like the longest speech, say 'counted'."
  - "I approve this moment, skip that one."
  - "Ask, opened with the slash key, answers from the video's own transcript and cites times. When I ask it to change something, it asks me first: it shows a card, and I approve, edit or reject."
  - "Prepare: the trim strip snaps to sentence ends; a free cut is possible with Alt but carries a warning. Checks say if the argument continues or the speaker is quoting someone else. A German-to-English subtitle track, editable, approved per language."
  - "Export: MP4 with burned-in subtitles, or the files. The checklist blocks export until checks, credit and speaker names are settled."
- **Fallback:** if the network or the server is slow, switch to the showcase video right away; don't wait for a page.

## Slide 5. How the AI is built

- **Message:** each course technique has one clear job in the product.
- **Visual:** a table, one row per technique:

| Technique | Where it works in Digestor |
|---|---|
| LLM APIs (Claude Haiku/Sonnet 5.5 via Anthropic or OpenRouter) and AssemblyAI | analysis agents, checks, translation, Ask; transcription with speaker labels |
| LangChain | every model call: `withStructuredOutput` + zod schemas, provider adapters (Anthropic, OpenRouter), tool calling for Ask |
| Prompt engineering and grounding | facts tagged with their source, verbatim quote check, lenient schemas with per-item degradation, transcript wrapped as `evidence()` |
| ChromaDB | one transcript index per video, local multilingual e5 embeddings, used by Ask |
| LangGraph | Ask: approval pause before any change (`interrupt`), verify loop, fan-out across videos (`Send`) |
| RAG with function calling | Ask: search, read transcript ranges, propose or trim clips, set selections |

- **Speaker notes (1:00):** "Every model call goes through LangChain. The analysis agents use structured output with zod schemas; the schemas are lenient and validated in code, so one odd reply drops one item, not a paid session. Facts carry their source: from the video, from metadata, from you, or suggested by AI. Quotes are checked word for word. Swapping Anthropic for OpenRouter is one adapter pair. ChromaDB holds a transcript index per video with local multilingual embeddings, so the transcript doesn't go to another vendor for search. LangGraph runs Ask, which is a real agent: the model picks its tools, and the graph stops for my approval before any change, then checks quotes and cited claims before the answer is stored. The upload pipeline started on LangGraph too; I'll come back to why it left."

## Slide 6. The data

- **Message:** real public-interest videos in three languages, labelled by hand, plus official records.
- **Visual:** a grid of the evaluation videos with language, length, golden file size and review status.

| Video | Language, length | Golden file | Reviewed by me |
|---|---|---|---|
| Globo debate, Lula × Flávio Bolsonaro | Portuguese, 1 h 57 min | 15 topics, 71 moments (14 / 31 / 26), 9 traps | yes |
| Osang × Merkel, Berliner Ensemble | German, 99 min | 12 topics, 14 moments (9 / 3 / 2), 8 traps, 149 speaker turns | not yet |
| Senado plenary, 30 Jun 2026 | Portuguese, 5 h 19 min | 30 speaker turns, 18 people | yes |
| Bundestag, 16 Oct 2026 | German, 32 min | 20 turns, 10 people | not yet |
| US House, 3 Sep 2026 | English, 65 min | 33 turns, 16 people | not yet |
| Ask questions | Globo + Osang | 12 per video (10 answerable, 2 not; 7 in another language) | not yet |

- **Monitor data (extension):** Câmara open-data API and bulk files since 1 Feb 2026; dev data, 11 Nov: 568 deputies, about 8,000 speeches, 126 roll calls, about 51,000 votes.
- **Speaker notes (45 s):** "I evaluate on real videos, not synthetic ones. The golden files were drafted by Claude from the transcripts and then checked; the debate and the Senate ones I reviewed and accepted, the newer ones I have not yet, and I'll say that on every number that comes from them. The traps are hand-made: moments where a clip would cut an argument or show someone quoting an opponent. For the names, the official records of each house are the second data source: Senado, Câmara, Bundestag, US House. The monitor runs on the Câmara's open data only."

## Slide 7. Evaluation: the analysis and the names

- **Message:** topics and names are reliable; moment recall and the "argument continues" check are the weak spots.
- **Visual:** two small tables.

Analysis (Claude Haiku 5.5):

| Metric | Globo debate (v1) | Osang × Merkel |
|---|---|---|
| Topic boundary error, mean | 14.1 s | 31.2 s |
| Moment recall, exchange | 10/14 | 6/9 |
| Moment recall, passage | 26/31 | 0/3 |
| Moment recall, punchline | 17/26 (18–21/26 after fixes) | 2/2 |
| Trap warnings, quoted opponent | 5/5 | 4/4 |
| Trap warnings, mid-argument | 2/4 | 4/4 |
| LLM cost of the analysis | about $0.13–0.15 a run | $0.145 ($0.088 per hour of video) |

Speaker names, attribution score `(correct − 5 × wrong) / total`: debate 0.99, Senado 0.93 (0.84 before the fix), Bundestag 0.95, US House 0.85, Osang × Merkel 1.00.

- **Speaker notes (1:00):** "Topic boundaries land within 14 seconds on the debate and about half a minute on the interview. The quoted-opponent check fired on every trap, and it is not just warning on everything: on control moments far from any trap it fired 3 times in 19, against 10 in 13 on trap moments. The mid-argument check is weaker: 2 of 4 on the debate with Haiku. On the interview it caught 4 of 4, but that golden isn't reviewed yet. Passage recall on the interview is 0 of 3, mostly a granularity mismatch: the golden passages are whole two-minute answers. For names, a wrong second costs five times a right one; after fixing how the Senate record is matched the score went from 0.84 to 0.93 with no wrong names. An analysis costs about 9 cents of LLM per hour of video."

## Slide 8. Evaluation: Ask and search

- **Message:** Ask finds and cites the right passages most of the time; the verify step makes it safer, but on 12 questions per video I can't show it makes it better.
- **Visual:** the before/after table (Haiku 5.5 via OpenRouter, 13 Nov), plus a third box for the monitor search.

| Metric | Globo before | Globo after | Osang before | Osang after |
|---|---|---|---|---|
| Retrieval recall@6 | 0.80 | 0.80 | 0.70 | 0.70 |
| Retrieval MRR | 0.75 | 0.75 | 0.70 | 0.70 |
| Citation hit | 80% | 90% | 100% | 80% |
| Quote exact | 100% | 100% | 71% | 100% |
| Refusal correct (2 questions) | 50% | 100% | 100% | 50% |
| Gave up on the step limit | 3 of 12 | 1 of 12 | 0 of 12 | 1 of 12 |
| Sent back by verify | – | 1 of 12 | – | 1 of 12 |

Monitor search (extension), 20 queries over 7,899 speeches of 2026 (14 Portuguese, 6 English); golden labelled by the coding agent (Claude), my review pending:

| Metric | Words | Meaning | Hybrid (RRF, what `/monitor` shows) |
|---|---|---|---|
| Recall@10 | 0.41 | 0.53 | 0.61 |
| MRR@10 | 0.66 | 0.82 | 0.87 |

Hybrid vs words on recall@10: better on 12 queries, equal on 6, worse on 2.

- **Speaker notes (1:00):** "'Before' is the plain tool loop; 'after' is the LangGraph version with approval and verify. Retrieval misses 5 of 20 answerable questions; those are figures and names that the question's words don't resemble. The agent still finds most of them because it reads transcript ranges and searches again, which is why citation hit is higher than recall. Verify sent one answer back per video and both corrections passed. The debate got better and the interview got worse, but with 12 questions one question moves a rate by 8 to 10 points, so both changes are inside the noise. I would not claim more than that. For the monitor, search by meaning is fused with word search by reciprocal rank fusion. Over 20 queries, recall at 10 goes from 0.41 with words to 0.61 hybrid, and MRR from 0.66 to 0.87; hybrid is better on 12 queries and worse on 2, broad cost-of-living ones where meaning pulls in fuel prices. The queries were labelled by the coding agent and I still have to review them."
- **If short of time:** read only the citation-hit and refusal rows.

## Slide 9. Risks and safeguards

- **Message:** the risks are decontextualised quotes, wrong names, privacy, copyright, bias and prompt injection; each has a safeguard in code, and each still has an open part.
- **Visual:** a three-column table: risk, what the code does, still open.

| Risk | Safeguard | Still open |
|---|---|---|
| Quote out of context | sentence snapping; checks for "argument continues", "quoting someone else"; export blocked until checks hold or are acknowledged | mid-argument check 2/4 on the debate |
| Wrong name on a voice | AI names are proposals until confirmed; trial profile never shows unconfirmed names; record thresholds raised where the eval showed errors | 4 videos; 4 goldens (Osang, Bundestag, US House, Ask) not reviewed |
| Personal data | audio to AssemblyAI (US), text to the LLM provider; embeddings local; video, audio and index deleted after 14 days (default) | transcripts and analyses kept with no expiry; no delete-my-data |
| Copyright | credit field drawn on the clip; export blocked until a credit or "No credit needed" | the app can't judge the right to quote |
| Selection bias | the model proposes, the human chooses; "AI" badge and "Why:" line | side balance not measured yet |
| Prompt injection in a transcript | `evidence()` wrapper; nothing changes without approval; at most 3 changes per question | a model can still be talked into a wrong answer |
| Monitor | no AI-written text about a person, no rankings, no scores, never "absent" | which records are shown and how they're sorted are still choices |

- **Speaker notes (45 s):** "The biggest risk is a quote that means something else out of context, so cuts snap to sentences and the checks block export until they hold or I acknowledge them. Names from AI are only proposals, and on a trial an unconfirmed name is never shown. Video, audio and the search index are deleted after 14 days by default; the open gap is that transcripts stay, and there is no delete-my-data yet. A transcript is untrusted text, so Ask reads it as marked evidence and can't change anything without my approval. In the monitor, the AI never writes about a person: it only finds and labels official text."

## Slide 10. What was hard

- **Message:** the hard parts were trust and noise, not features.
- **Visual:** three cards with one line each.
  1. **LangGraph in the wrong place.** The pipeline ran on LangGraph for eleven days (29 Oct – 9 Nov). Once the clip-review pause moved to the Briefing page, it was a straight line of ten steps with one pause. Replaced by a step runner on one Postgres row with compare-and-set; LangGraph moved to Ask, where the model controls the flow.
  2. **Run-to-run noise.** Same code, same model: passage recall moved from 20 to 26 of 31 between two runs. Single runs can't separate models that differ by a few moments.
  3. **Official records are messy.** The Senate record prints the chair's replies inside a senator's speech; the matcher named the chair after the senator. Matching only the speech's own parts fixed it (0.84 to 0.93, no wrong names).
- **Speaker notes (45 s):** "Three lessons. First, I picked LangGraph for the pipeline because the first design had two human pauses that could last days. When the review pause went away, the pipeline was a straight line and LangGraph only added risk, like re-paying transcription on a wrong resume. I replaced it with a small step runner and used LangGraph where the model really chooses the path: Ask. Second, LLM runs are noisy, so I report ranges and controls, not single numbers. Third, real records are messy, and the evaluation is what found the bug in matching names."

## Slide 11. What's next

- **Message:** the next step is the Câmara monitor in front of a real journalist on 1 Dec, then accounts and more history.
- **Visual:** a timeline from 17 Nov to 1 Feb 2027 with the four goals below; already built for the monitor this round shown as ticks: video moment per speech, words used more than the chamber (counted, no AI), vote and bill filters with party guidance, search by meaning (hybrid with word search). Not built yet: "Ask the record" (D3), "Clip this speech" (D2), the rest of the vote and bill filters (D6 part 2) and the audio-only check (D7). The D4 and 2023–25 boxes carry the tag "proposal to confirm" on the slide.
- **SMART goals** (dates from the monitor roadmap where it has them; the D4 and 2023–25 rows are proposals to confirm, and say so on the slide):

| Goal | Specific | Measurable | Achievable | Relevant | Time-bound |
|---|---|---|---|---|---|
| Câmara monitor demo | A Brazilian journalist uses the monitor on production: find a deputy, search a topic, open a speech at its video moment, read a roll call | 4 tasks (find a deputy, search a topic, open a speech at its video moment, read a roll call); at least 3 of 4 done without help; time per task noted with the user-test checklist | the monitor preview, video moments per speech and the word heat map are built and reviewed | journalists are the target users of both products | feature cut-off Fri 27 Nov, production frozen Mon 30 Nov, demo Tue 1 Dec 2026 |
| Sign-in and registration | email and password with verification and reset; real user ids replace the single owner on selections, clips and subtitle tracks | a new user registers, verifies the email and resets the password by email in under 5 minutes; 0 rows lost from the existing owner's selections, clips and subtitle tracks; all test suites green | proven auth library, sessions in Postgres | the journalist must be able to use it alone after the demo | built 23–25 Nov, live for the 1 Dec demo; if sign-in slips, the 1 Dec demo runs on the shared password |
| D4 topic labels (proposal to confirm) | AI labels speeches with topics from a fixed list; labels only, never text about a person | provisional target: at least 80% agreement with a hand-labelled set of 50 speeches | same pattern as the word heat map, plus one fast-model call per speech | journalists search themes, not exact words | decide in the week of 23 Nov; if agreed, labelled set and first run by Fri 11 Dec 2026 |
| 2023–25 history (proposal to confirm) | load the legislature's earlier years (from 1 Feb 2023) of speeches, roll calls and votes; years selectable on every page | per-year counts of speeches, roll calls and votes within 1% of the Câmara API's per-year totals | the backfill script and bulk-file parsers exist; the year list (`MONITOR_YEARS`) holds only 2026 today | a deputy's record since the start of the mandate is what journalists ask for | by 31 Dec 2026, before the public beta on 1 Feb 2027 |

- **Speaker notes (45 s):** "Digestor is the capstone; the Câmara monitor is where it goes next. It applies the same rule to official records: the AI finds and labels, it never writes about a person. This round added the video moment for each speech, the words a deputy uses more than the rest of the chamber, counted with log-odds and no AI, vote filters against the party's guidance, and search by meaning fused with word search. On 1 December a Brazilian journalist tries it on production. Before that: sign-in, so she can use it alone afterwards. In December: topic labels if we agree on them, and the history back to 2023, before the new legislature starts in February."
- **If short of time:** say two goals aloud: the 1 Dec demo and sign-in.

---

## Likely questions (5 minutes)

1. **The brief asks for LangGraph. Why isn't the upload pipeline on LangGraph?**
   It was, from 29 October to 9 November. It left when the pipeline became a straight line of ten steps with one pause: the checkpointer saved four small fields, held the journalist's answers in extra tables that retention had to clean, and a wrong resume could re-run paid transcription. The replacement is one Postgres row per session moved by compare-and-set, with the pause written in the same transaction as the stage. It was a tidy-up, not a saving. LangChain stayed for every model call, and LangGraph now runs Ask, where the model picks the tools and the graph pauses for approval. Full answer and diagrams: `reports/langgraph-why-not.pdf` (section 9 has the follow-up questions).

2. **Claude drafted your golden files. Isn't the evaluation grading itself?**
   Partly, and I say so. The Globo debate and Senado goldens I reviewed and accepted; the interview, Ask, Bundestag and US House goldens are not reviewed yet. The traps are scored against control moments so "warn on everything" can't pass, and the names are checked against official records. The samples are small: 12 Ask questions per video, where one question moves a rate by 8 to 10 points.

3. **The verify step didn't clearly improve Ask. Why keep it?**
   It is a safety net, not a score booster. It catches misquotes and unsupported claims before the answer is stored: it sent one answer per video back, and both corrections passed. A wrong quote in a journalist's hands costs much more than a slower answer. The two "after" runs cost $0.038 and $0.035 for 12 questions each, judge calls included.

4. **What does one video cost?**
   On the interview the LLM analysis was $0.145, about $0.088 per hour of video, and the checks $0.015 (Haiku 5.5 via OpenRouter). Transcription is the larger part: about $0.23 an hour with AssemblyAI's Universal-3.5 Pro plus speaker labels (from the debate run). The app's default reasoning model is Sonnet 5.5, which costs more; the measured runs used Haiku 5.5 for every step.

5. **How do you stop a decontextualised quote from getting published?**
   Three layers. Every cut snaps to a sentence boundary unless I hold Alt, and then it carries a warning. Checks flag "the argument continues", "quoting someone else", context risk and interpreter audio, and export is blocked until they hold or I acknowledge them; any trim resets the acknowledgement. And nothing is exported without a human approving the moment, the clip and each subtitle language. The weak layer is the mid-argument check (2 of 4 on the debate), so the human approval is the real safeguard.

Spare, if time allows:

- **Why ChromaDB and not pgvector?** Chroma runs beside the app with local embeddings, so transcripts aren't sent to an embedding vendor, and pgvector would have needed a different Postgres image on production. Moving to pgvector later, to run one database less, is on the monitor roadmap.
- **What if the transcript says "ignore your instructions"?** Transcript text reaches Ask only inside an `evidence()` block it can't close, nothing changes without my approval on a card, and at most 3 changes per question.
