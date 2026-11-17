# Digestor showcase

**Status: optional, not uploaded yet.** The showcase entry and video have not been made; this page is the plan for them. The screenshot list below is also the fallback for the presentation's demo.

Text and shot list for the optional Turing College showcase (a short video plus a link in the README). Audience: reviewers and journalists.

## Description (about 125 words)

Journalists who cover debates, hearings and long interviews lose hours finding the few minutes that matter, then more hours cutting and subtitling them. Digestor does the first pass. Upload a video or paste a YouTube link, answer a few questions about it, and read an AI briefing: topics, moments at three scales (exchange, passage, punchline) and highlights suited to the kind of event. Every quote is checked against the transcript. You approve or skip moments, trim clips on sentence boundaries, add translated subtitles and export MP4, SRT and VTT. Ask answers questions about the video from its stored data. The journalist decides; the AI only proposes.

Stack: TypeScript, Next.js, Node worker with pg-boss and Postgres, Claude through LangChain, AssemblyAI, ChromaDB, ffmpeg.

## Video script (about 85 s)

Record at 1280 px wide, one pass, no voice-over of keyboard shortcuts. Examples: the Globo presidential debate (Lula and Flavio, Portuguese) and the Alexander Osang interview with Angela Merkel (Berliner Ensemble, 7 June 2022, German).

| # | Time | Shot | Narrator |
|---|---|---|---|
| 1 | 0-8 s | Sessions page with the Globo debate and the Osang interview listed | "A two-hour debate or interview holds a few minutes a journalist can use. Finding them is slow." |
| 2 | 8-16 s | Upload page, paste the Osang link, language picker | "Digestor takes a file or a YouTube link, in any language AssemblyAI supports." |
| 3 | 16-24 s | Processing with progress, then the Context check with questions | "It transcribes, works out what kind of event this is and asks you only what it cannot tell." |
| 4 | 24-36 s | Briefing page: summary card, topic card, moment tree, highlight chips with "Why:" | "You get a briefing: topics, then moments as exchanges, passages and punchlines. Each AI highlight says why." |
| 5 | 36-44 s | Click a moment, the quote and playback; Approve one, Skip one | "Quotes are checked against the transcript. You approve or skip each moment." |
| 6 | 44-52 s | Ask drawer: a question with a cited answer, then Ask proposes a clip change and the approval card (Approve / Edit / Reject) | "Ask answers from the video's own data. It asks before it changes your selection." |
| 7 | 52-62 s | Prepare: trim strip, 9:16 toggle, credit, German to English subtitle track | "Trim on sentence boundaries, pick the format, add translated subtitles you can edit." |
| 8 | 62-72 s | Export: rendered clip playing, download buttons, Download all | "Export MP4 with subtitles burned in, or SRT and VTT files." |
| 9 | 72-80 s | Who's who with speaker names and sources | "Speaker names carry their source, and an AI guess stays a proposal until you confirm it." |
| 10 | 80-87 s | Câmara monitor search results (extension) | "The same approach, on official parliamentary records, is the next step." |

Word count of the narration is about 190, which fits 85 s at a calm pace.

## Screenshot list

Seed with the `digestor-run` skill. "Real" means one of the owner's analysed sessions: the Globo debate (`7433d1c6...`) or the Osang interview once analysed. "Seed" means `seed-demo.ts --stage ready` (a mayor interview, 3 topics, 14 moments) or `--stage awaiting_context`. Never delete the owner's real sessions. Take desktop shots at 1280 px; shots marked "mobile" also at 390 px (`--mobile`).

| # | Screen | Route | State to set up | What it should show |
|---|---|---|---|---|
| 1 | Sessions | `/` | Real sessions: Globo debate and Osang interview, plus one seed ready | Several videos with their stage, type tabs, filters |
| 2 | Upload | `/new` | Empty form, a YouTube link pasted | Link field, language picker, stepper on Upload |
| 3 | Processing | `/s/<id>` | A real run, or a fresh upload with keys; capture during transcription | Stepper on Processing, progress, plain-language stage |
| 4 | Context check | `/s/<id>` | `seed-demo.ts --stage awaiting_context`, or Osang at the pause | Facts with source tags ("from video", "suggested by AI"), open questions, Continue and Skip |
| 5 | Briefing top | `/s/<id>` | Real Globo debate, `ready` | Summary card, top highlights, briefing text, stepper on Briefing |
| 6 | Topic card and moment tree | `/s/<id>` | Globo debate; scroll to one topic; levels all ticked; two moments Approved, one Skipped | Exchange, passage and punchline rows, chips with "AI" badge and "Why:", Approve and Skip states |
| 7 | Filters and hidden approved | `/s/<id>` | Choose a highlight-type chip that hides an approved moment | Footer "N approved · M hidden by filters" with "Show hidden" |
| 8 | Ask answer | `/s/<id>` (press `/`) | Osang interview ready; ask "What does Merkel say about Russia?" | Drawer with an answer citing timestamps, German source quoted |
| 9 | Ask approval | `/s/<id>` (press `/`) | Ask "Trim the first clip to start at the question" | Approval card showing the proposed change with Approve / Edit / Reject, before anything changes |
| 10 | Prepare | `/s/<id>/prepare` | Osang interview: two approved moments confirmed with "Prepare clips"; one clip at 9:16, credit filled, English track added | Trim strip with time, checks, crop position, credit, subtitle language and track status |
| 11 | Subtitle track | `/s/<id>/prepare` | Same; open the English track with a preview | German to English cues, editable, approval state |
| 12 | Export | `/s/<id>/export` | Wait until "Rendered" shows on both clips; toggle Watch on one | Rendered clip playing inline, MP4 / SRT / VTT downloads, "Download all" |
| 13 | Who's who | `/s/<id>` (Who's who panel) | Globo debate, names confirmed with source | Speaker names with source labels ("From the official record", "From a caption on screen", "From the transcript", "From you"; copied from `messages/en.ts` `evidence`) |
| 14 | Phone width | `/s/<id>` and `/` | Globo debate, `--mobile` | Briefing and Sessions at 390 px with nothing overflowing |
| 15 | Monitor (extension, last) | `/monitor` and a topic search | A search such as "saude" in the loaded 2026 data | Results as official text with matched words highlighted and "Searched for" terms; no ranking of people |

Notes for shooting:

- Frame the stepper in shots 2 to 12 so the flow reads left to right: Upload, Processing, Context, Briefing, Prepare, Export.
- Check `errors.txt` from `drive.mjs` is empty, and look at each PNG before using it.
- Shots 8 and 9 need keys for the LLM provider in `.env`.
- Blur nothing: the sessions are public-interest videos. Do not show `.env`, the server's address or API keys in a terminal.
