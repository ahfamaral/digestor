# Digestor — Design Document

**Date:** 2026-10-28
**Status:** Approved by owner 2026-10-29 (after reviewing the clickable walkthrough)
**Context:** Turing College AI capstone (open topic; TypeScript accepted). Builder: one developer, React/TypeScript (Next.js) background, ~2 weeks × 24 h ≈ 48 h for the first version.

Legend: **[decided]** = the owner decided it in conversation. **[my call]** = a default chosen by the designer, open to override. **[builder]** = left for the builder to decide.

---

## 1. Intent — what this is and why

Long public-interest recordings — interviews, parliament plenaries, UN sessions, court hearings — are hours long and nobody watches them end to end. The moments that matter (a heated clash, a concrete announcement, a moment of laughter) are buried.

**Digestor** ingests one long recorded video and turns it into a small set of **high-quality, subtitled clips** of the moments worth sharing, organised as a **tree**: long clips where a whole idea is debated, and shorter "hot take" clips inside them. The app first **works out what it is looking at** — the language, the kind of event, and its context — and **asks the human** when the video alone doesn't say enough (e.g. the year, or who the people are). An AI then proposes the clips with its reasons; a **human reviews, adjusts the cut points, and approves**; the app renders and the user **downloads** the clips for their own use. **[decided]**

Typical user: a journalist the morning after a long interview or session who wants the hottest clips ready to post on their social accounts. But the product is for anyone following public-interest video; journalists are one example. **[decided]**

Positioning vs. existing tools (OpusClip, ClipHive, OpenShorts): those optimise for creator "virality". Digestor optimises for **public-interest relevance**, grounded in the event's **context**, with an explicit long-clip → hot-take hierarchy and human approval.

### Capstone fit
The capstone asks for LLM APIs, LangChain, RAG, vector DBs (ChromaDB), prompt engineering and function calling, a deployed prototype, and a README. Each tool is used only where it adds product value:

| Tool | Product job |
|---|---|
| LLM API + prompt engineering | Understand the event (type, context, participants); segment the transcript into topics and hot takes with an event-type rubric; structured JSON output; reasoning before labelling |
| LangGraph.js (LangChain) + human-in-the-loop | The pipeline is a graph with **two human pauses**: (1) the context agent asks for missing context, (2) the clip review |
| Function calling | Copilot edits clips from plain-language instructions ("start when the guest begins answering") by calling tools |
| RAG with ChromaDB | Ask questions about the video ("what did she say about housing?") and get answers with clickable timestamps; one click turns an answer into a clip |

## 2. Goals, non-goals, anti-goals

### Goals (v1, 2 weeks)
1. **Runs locally** end to end with Docker (Colima) **and is deployable** with the same Docker Compose setup to a single server. **[decided: local + deployable; my call: single-server]** Production cost tuning is discussed later. **[decided]**
2. Works for **any interview in any language** (and other long public-interest formats). **[decided]**
3. User **pastes a YouTube link or uploads a video file** **[decided]**; the app **detects the spoken language**, **classifies the kind of event**, and **extracts the context** (topic, setting, participants, date/year if stated). **[decided]**
4. **Context agent (human in the loop #1):** if the video doesn't give enough context — e.g. no year, unknown names of the people — the agent **asks the human** targeted questions before clip-finding continues. The human can answer or skip. **[decided]**
5. App proposes ranked candidate clips as a tree (long clip → hot takes), each with a title, a label (Heated / Key point / Light moment), a score, and a one-line reason. **[decided: tree, labels; my call: "Key point" replaces "Policy" so it fits interviews]**
6. **Clip review (human in the loop #2):** Approve / Neutral / Reject, and adjust start and end of any clip. **[decided]**
7. Approved clips render as MP4 with **burned-in subtitles** in the spoken language; user downloads them. **[decided]**
8. Copilot drawer: function-calling edits + RAG Q&A over the transcript. **[decided via chosen UI]**
9. README for the showcase. **[decided: capstone requirement]**

### Nice to have (not required for v1)
- **Speaker name / role label** on the rendered clip, enabled by a **checkbox** at export. **[decided]**
- Cross-video search, ZIP export.

### Non-goals (v1)
- Writing captions, post text, hashtags, or anything that speaks for the user — output is **cuts + subtitles only**. **[decided]**
- Vertical/9:16 reframing, auto-posting to social networks. **[decided]**
- Live streams; only recorded videos. **[my call]**
- Accounts, teams, permissions (a single shared password protects the deployed app). Production cost tuning. **[decided: later]**
- Fine-tuning models.

### Anti-goals (would make it a failure even if it technically works)
- **Clips that misrepresent a speaker**: cutting mid-sentence, or trimming away the sentence that reverses the meaning. Cut points snap to sentence/pause boundaries; the long-clip parent preserves full context. **[my call — please confirm]**
- **Inventing context**: the app must not guess a year, a name or an affiliation and present it as fact. Unknowns are asked, or left blank. **[my call, follows from the context-agent decision]**
- An AI that finalises anything without human approval.
- A review flow so slow that a journalist gives up — triage must be keyboard-fast.

## 3. Constraints
- **Time:** ~48 h of work for v1; the rest is stretch. **[decided]**
- **Stack:** all TypeScript, Next.js. **[decided: Option A; course accepts TypeScript]**
- **Local first, deployable from day one:** locally, Colima runs Docker Compose (Postgres, ChromaDB, and the worker container with ffmpeg + libass, yt-dlp and Noto fonts); the Next.js app runs on the host with `pnpm dev`. In production the same compose file plus a production override runs everything — web container, worker, Postgres, ChromaDB, Caddy (HTTPS) — on **one VPS** (e.g. 4 vCPU / 8 GB / 80+ GB disk) with one shared data volume. The DB stores **storage-relative keys**, never absolute paths, because the host and the container see the data folder at different paths. **[decided: deployable; my call: how]**
- **Deployed app safeguards:** single shared password (`APP_PASSWORD`; no gate when unset locally), upload size cap (`MAX_UPLOAD_GB`, default 5), and automatic deletion of sessions older than `RETENTION_DAYS` (default 7). **[my call]**
- **Why not install ffmpeg on the Mac:** the Homebrew ffmpeg on the owner's machine lacks the subtitle (`ass`) filter; the container's Debian ffmpeg has it, and it's the same binary in production.
- **Media:** videos up to ~4 h (multi-GB). Heavy work (ffmpeg, transcription, rendering) runs in a long-running worker, never in request handlers.
- **Languages:** any language. Subtitles are in the spoken language. UI in English. **[decided: any language; my call: subtitle/UI language]**
- **YouTube links** are downloaded with yt-dlp (best ≤1080p, merged to MP4). Reliable from a home connection; **best-effort on a server**, because YouTube often blocks datacenter IPs — when blocked, the user sees a clear message suggesting they upload the file instead. No cookies or proxies are used. YouTube's terms apply: downloads are for personal use and the Export screen shows a responsible-use notice. **[decided: support links; my call: limits]**
- **YouTube metadata** (title, description, channel, upload date, URL) is saved with the session and is a `metadata` source for the context card — the upload date often answers the "when" question without asking. **[my call]**
- **Cost:** API spend roughly $1–2.5 per 4 h of video (see §9); no hosting costs while local.

## 4. Understanding the video: language, event type, context

### Language **[decided: detect; my call: how]**
The transcription API's automatic language detection sets the session language; the context agent confirms it from the text. Mixed-language videos are transcribed with the dominant language and flagged. The user can override the language at the context check.

### Event type **[decided: detect; my call: list]**
The context agent classifies the video into one event type. The type selects the **relevance rubric** used to find clips and the default **speaker-label template**:

| Event type | What counts as "hot" | Label template (nice to have) |
|---|---|---|
| **Interview** (v1 focus) | Revealing or surprising answers, pushback between interviewer and guest, evasions, strong claims, humour | Name · Role |
| Panel / debate | Disagreements, direct rebuttals, strong claims, crowd reactions | Name · Role |
| Parliament | Government/opposition clashes, votes, concrete figures, interruptions, calls to order, laughter | Name · Party |
| UN / diplomatic | Accusations between delegations, rights of reply, votes, announcements | Name · Country |
| Court / hearing | Objections, rulings, key testimony, sharp cross-examination | **Role only** |
| Other | Disagreement, novel claims, emotional peaks, humour | Name |

Event types are data (a TS object each: rubric text, few-shot examples, label template), so adding one is a config change. Only **Interview** is tuned with few-shot examples and evaluated in v1; the others ship as rubric config. **[my call]**

### Context **[decided]**
The context agent produces a **context card**:
`{ language, event_type, title, summary, setting (where / which institution or show), date_or_year, participants: [{ speaker_id, name?, role?, affiliation?, source: "video" | "metadata" | "human" }], open_questions: [...] }`

Sources, in order: the transcript (introductions like "joining me today is…", dates mentioned), file metadata / filename (and YouTube title/description/upload date when a link is used), and the human. Every field records where it came from. Nothing is invented: fields the agent can't support from a source stay empty.

The context card is injected into every later prompt (clip finding, titles, copilot), because relevance depends on context ("this is the minister's first interview since the scandal").

### Context agent — human in the loop #1 **[decided: separate node + asks human; my call: rules]**
- After transcription, the agent drafts the context card and decides whether context is **sufficient**. It must ask when: the event type is uncertain, there is no date/year anywhere, or the main participants can't be identified.
- If insufficient, the graph **pauses** and the UI shows a short **Context check**: what the agent understood (editable) plus at most ~3 targeted questions ("When was this recorded?", "Who is the woman interviewed from minute 2?"), each with a play-sample button.
- The human answers (free text or form fields), edits the card, or clicks **Skip**. Answers are recorded with `source: "human"`. The agent may ask **one** follow-up round if an answer raises a new gap, then continues.
- If context is sufficient, the card is shown as a dismissible banner on the review screen instead of blocking.

### Speaker names (nice to have) **[decided: optional checkbox]**
Names come only from the context card (video / metadata / human). At export, a checkbox **"Show speaker labels"** burns in a lower-third using the event type's template. Names with no source are never shown — the label falls back to role, or nothing. **[my call]**

## 5. Architecture **[decided: Option A — all TypeScript; local first; my call: components]**

```
 Browser (Next.js: Upload · Processing · Context check · Review inbox · Edit cut · Copilot drawer · Export)
        │  HTTP + SSE (progress)
        ▼
 Next.js server (route handlers / server actions)
        │  enqueue jobs, read/write state, resume graph with human input
        ▼
 Postgres ── job queue (pg-boss) ── LangGraph checkpoints ── app tables       (docker compose)
        ▲
        │ consumes jobs
 Worker (Node, same repo) ── ffmpeg / ffprobe (local binaries)
        │                 ── Transcription API (language detection + word timestamps + diarisation)
        │                 ── LLM API via LangChain.js (context agent, clip finding, copilot)
        │                 ── Embeddings API → ChromaDB (docker compose)
        ▼
 Storage interface → local folder ./data/ (later: S3-compatible bucket)
```

- **Monorepo** (pnpm workspaces): `apps/web` (Next.js), `apps/worker` (Node), `packages/core` (types, zod schemas, DB schema, event types, prompts, storage interface). **[my call]**
- **Local services:** `docker compose up` (via Colima) starts Postgres, ChromaDB and the **worker container** (Node 22 + ffmpeg with libass + yt-dlp + Noto fonts, source bind-mounted for hot reload). The web app runs on the host. Both see the same `./data` folder (bind-mounted into the worker). **[my call]**
- **Production:** `docker-compose.prod.yml` adds the web container (Next.js standalone build) and Caddy (automatic HTTPS) on one VPS; all services share the data volume. **[my call]**
- **Uploads:** streamed to `<data>/<session>/original.*` through a Next.js route handler — works locally and on the single server (Caddy has no body limit). A move to split hosting later would switch to presigned uploads to S3/R2 behind the same storage interface. **[my call]**
- **DB:** Drizzle ORM. **Queue:** pg-boss on the same Postgres. **[my call]**
- **Progress:** worker writes stage + percentage to the session row; web streams via SSE (polling acceptable). **[builder]**
- **Playback:** worker makes a 480p H.264 **proxy** for fast seeking; rendering uses the original. **[my call]**

### Model / API defaults **[my call — all swappable via LangChain provider abstraction]**
- **Transcription:** hosted API with **automatic language detection, word-level timestamps and speaker diarisation** across many languages (e.g. AssemblyAI or Deepgram). OpenAI Whisper API is the fallback (no diarisation, 25 MB/request → chunking). **[builder]** picks after testing two short samples in different languages.
- **Reasoning LLM** (context agent, clip finding, copilot): Claude Sonnet 5.5 (`claude-sonnet-5-5`) — long context fits a 4 h transcript (~50–70k tokens), strong multilingual.
- **Cheap calls** (titles, small classifications): Claude Haiku 5.5 (`claude-haiku-5-5`).
- **Embeddings:** a multilingual embedding model, e.g. OpenAI `text-embedding-3-small`. **[builder]** may swap for a stronger multilingual one.

## 6. The pipeline (LangGraph.js graph) **[decided: LangGraph + HITL + separate context node; my call: node breakdown]**

Graph state is persisted with the Postgres checkpointer, keyed by `session_id` as the thread id, so either pause can last as long as needed.

| # | Node | What it does | LLM? |
|---|---|---|---|
| 0 | `download` | YouTube links only: yt-dlp download + metadata (title, description, channel, upload date) | no |
| 1 | `ingest` | Validate the video (ffprobe), read container metadata, extract audio (mono 16 kHz), make 480p proxy | no |
| 2 | `transcribe` | Transcription API with language detection; store words (text, start, end, speaker, confidence) | no |
| 3 | `audio_signals` | Per-second loudness (ffmpeg `ebur128`) + speaker-turn rate and overlap from diarisation → **heat curve** (0–1 per second) | no |
| 4 | `understand_context` | Context agent drafts the context card (language, event type, setting, date, participants) from transcript + metadata; decides sufficiency; writes open questions | yes (Sonnet) |
| 5 | `ask_context` | **`interrupt()` #1** — only if context is insufficient. Resumes with the human's answers or "skip"; may loop back to node 4 once | human |
| 6 | `index` | Chunk transcript into ~45–60 s windows on sentence boundaries; embed; upsert into Chroma with metadata (session, start, end, speakers) | embeddings |
| 7 | `find_clips` | **Pass 1:** full transcript + context card + heat peaks → long-clip candidates (typically 2–12 min). **Pass 2:** per long clip → hot takes (typically 15–90 s) inside it. zod-validated structured output | yes (Sonnet) |
| 8 | `snap` | Snap start/end to the nearest sentence end / pause ≥ 300 ms using word timestamps; enforce child ⊂ parent | no |
| 9 | `review` | **`interrupt()` #2** — UI shows the inbox. Resumes when the user clicks "Render approved" | human |
| 10 | `render` | For each approved clip: ASS subtitles from words, burn in with ffmpeg (re-encode, frame-accurate), optional speaker lower-third; write MP4 + `.srt` | no |

Nodes 3 and 4 can run in parallel after 2; node 6 can run in parallel with 4–5. Re-cuts after the first render use a standalone `render_clip` job, not the whole graph. **[my call]**

### Prompt engineering **[my call]**
- **Context agent prompt:** extract only what is supported by a quoted transcript line or metadata field (each field carries its evidence); output the card + a `sufficient: boolean` + `open_questions` (max 3, most important first, phrased for a non-technical person).
- **Clip-finding prompt:** role + context card + the event type's rubric + label definitions + hard rules (never start/end mid-sentence; a long clip contains a complete exchange — question/claim, answer/response, and rebuttal if present). Input = `[hh:mm:ss] SPEAKER: sentence` lines + heat peaks. Output per clip: `{ title, reason, label: "heated"|"key_point"|"light", score 0–100, start, end, evidence: [timestamps] }` — `reason` is generated **before** `label` and `score`. Titles are in the spoken language. **[my call]**
- 2–3 few-shot examples for the Interview type, from a labelled excerpt that is **not** the evaluation video (§10).
- Ask for more candidates than will be approved (e.g. 15–25); inbox sorts by score.

## 7. Data model **[my call]**

- `sessions` — id, title, source (upload | youtube), source_url, metadata (JSON: YouTube/container metadata), original_key, proxy_key (storage-relative keys), duration_s, language, event_type, status/stage/progress, created_at
- `context_cards` — session_id, card JSON (fields + per-field source + evidence), sufficient, open_questions, human_answers, version
- `words` — session_id, idx, text, start_ms, end_ms, speaker_id, confidence (or one JSON blob per session — **[builder]**)
- `heat` — session_id, per-second array (JSON)
- `clips` — id, session_id, **parent_id** (null for long clips), title, label, score, reason, start_ms, end_ms, **status** (proposed | approved | neutral | rejected), **origin** (ai | user | copilot), out_of_bounds, render_status, render_path, srt_path
- `clip_events` — audit trail of edits/decisions (who: user/copilot, what changed); powers copilot "undo"

### Tree rules **[my call — please confirm]**
- Parent and children are **linked but independently reviewable**. Rejecting a parent does not reject its children.
- If a parent's edited boundaries exclude a child, the child is flagged `out_of_bounds`; the user can detach it (becomes standalone) or reject it.
- Users can create clips (from transcript selection, the heat timeline, or the copilot) with `origin = user|copilot`.
- "Neutral" = kept on record, not rendered, hidden by the default inbox filter.

## 8. User experience **[decided: B inbox + A timeline/trim in Edit cut + C copilot drawer]**

Mockups: `.superpowers/brainstorm/*/content/visual-directions.html` (style options) and `.superpowers/brainstorm/*/content/walkthrough.html` (approved clickable walkthrough of all screens). The walkthrough is the visual reference for the build.

1. **Upload** — two tabs: **Upload a file** or **Paste a YouTube link**. Optional free-text "anything we should know about this video?" field, which seeds the context card with `source: "human"`. No event-type picker — it's detected. **[my call: optional hint field]**
2. **Processing** — stepper with live stages (Uploading → Transcribing → Understanding context → Finding moments → Ready). User can leave and return.
3. **Context check** (only when needed) — a focused card: "Here's what I understood" (language, event type, setting, date, people — each editable, each showing its source), then up to 3 questions with play-sample buttons, and **Continue** / **Skip**. Same visual language as the inbox (light, card-based).
4. **Review inbox (B)** — light card grid. Context banner on top. Filter chips: All / Heated / Key point / Light / Approved / Neutral. Each long-clip card: thumbnail, duration, title, label chip, AI reason, nested hot takes. Keyboard: **A** approve · **N** neutral · **R** reject · **E** edit cut · **↓/↑** move.
5. **Edit cut (A)** — player on the proxy, **full-video heat timeline** with clip markers, zoomed **trim strip with drag handles** that snap to pauses (modifier key disables snapping), exact `hh:mm:ss.s` fields, the clip's transcript with in/out highlighted, children listed for the same treatment.
6. **Copilot drawer (C)** — slides in from the right on review/edit screens:
   - **Instructions via function calling**: "start clip 3 when the guest begins answering", "make a 30-second hot take of the 'six hundred beds' line", "reject all light moments". Tool calls shown as chips; every change undoable and still subject to human approval.
   - **Questions via RAG**: "what did she say about housing?" → answer citing `[hh:mm:ss]` links that seek the player; **Clip this** creates a proposed clip from the cited span.
7. **Export** — approved clips with render status; checkbox **Show speaker labels** (nice to have); download MP4 (+ `.srt`).

Styling: light, airy, card-based app shell; the Edit cut player/timeline area may use a darker "studio" panel. shadcn/ui + Tailwind suggested. **[my call; exact styling = builder]**

### Copilot tools (function calling) **[my call]**
| Tool | Purpose |
|---|---|
| `search_transcript(query, k)` | Chroma vector search + keyword match; returns spans with timestamps/speakers |
| `get_transcript(start, end)` | Exact words in a range |
| `get_context()` | The context card |
| `list_clips(filter)` | Current clips and statuses |
| `propose_clip(start, end, title, label, parent_id?)` | Creates a `proposed` clip (never approves) |
| `adjust_clip(clip_id, start?, end?)` | Moves boundaries; auto-snaps; returns new values |
| `snap_to_pause(time, direction)` | Nearest clean boundary |
| `set_status(clip_ids, status)` | Bulk status change — **requires in-UI confirmation** |

The copilot is a LangGraph.js tool-calling agent. It can never render or download on its own.

## 9. Cost estimate per 4 h of video **[my call — verify against current price pages]**
- Transcription with language detection + diarisation: roughly $0.50–$1.50 depending on vendor.
- Context agent + clip finding (Sonnet, ~70k in / ~10k out, ~3 calls): roughly $0.40–$0.80.
- Embeddings and small calls: cents. Rendering: local CPU.
- **Total ≈ $1–2.5 per 4 h**; a 1 h interview is roughly a quarter of that. Production hosting costs: later. **[decided]**

## 10. Evaluation **[my call]**
Hand-label one real interview (~1 h) as the "golden" set: 3–5 long clips and their hot takes with start/end, plus the correct context card. A script runs the pipeline and reports: golden moments found (overlap ≥ 50%), boundary error in seconds, context-card accuracy (event type, language, participants), and proposals a human would reject. Use it to iterate on prompts; show results in the README. Ideally also run a second interview in another language to show the multilingual claim holds.

Few-shot examples come from a **different**, separately labelled excerpt, never from the evaluation video. The owner labels both (~2–3 h total).

## 11. Delivery order (~48 h; details go in the implementation plan)
- **Week 1 — core loop works end to end, locally, and is deployed:** monorepo + docker compose (worker container) → upload or YouTube link → ingest/proxy → transcription (language detected) → context agent + context check pause → clip finding → review inbox (approve/neutral/reject) → timestamp-field edits → render with burned subtitles → download → deploy to one VPS (HTTPS, password, retention).
- **Week 2 — the differentiators:** heat curve + Edit cut timeline with snapping trim handles → Chroma index + copilot drawer (RAG Q&A + function-calling edits) → evaluation script → README + showcase.
- **Nice to have / stretch:** speaker labels checkbox; cross-video search; ZIP export.

If week 1 slips: the copilot shrinks to RAG Q&A only and the heat timeline becomes static. The core loop (understand → ask → propose → review → adjust → download) is never cut.

## 12. Risks
| Risk | Mitigation |
|---|---|
| Context agent invents facts | Every field needs a source + evidence; unknowns become questions; human edits the card |
| Agent asks too much / too often | Max 3 questions, one follow-up round, always skippable; non-blocking banner when sufficient |
| Clip quality vague or too broad | Event-type rubric, context card in prompt, two-pass finding, evaluation script |
| Weak quality in some languages | Vendor tested on 2 languages up front; multilingual embeddings; mixed-language flag |
| Cut points feel awkward | Word-level snapping, child ⊂ parent rule, human trim |
| Slow rendering on a laptop | Render only approved clips; proxy for preview; one render at a time |
| YouTube blocks the server | Clear error suggesting file upload; upload is always available; no cookie/proxy workarounds |
| Public server abused / disk fills | Password gate, upload size cap, retention clean-up |

## 13. Left to the builder
Exact UI styling and components; transcription vendor (after sample test); SSE vs polling; words storage shape; chunk sizes and Chroma collection layout; test strategy details; repository/CI setup; VPS provider.
