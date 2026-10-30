---
name: digestor-ui
description: Frontend conventions for Digestor's web UI (concept agreed 2026-10-30 and built in Plan 2: Preview → Full briefing → Prepare clips → Export) — visual tokens, semantic colours, shadcn/Base UI components, layout, exact copy, keyboard triage, accessibility, multilingual content and how to verify a screen. Use this before building or changing any screen or component in apps/web (upload, processing, context check, Preview, Full briefing, Prepare clips, Ask drawer, export, reports, login) and for later parts (speaker names, Tracker) — also for small tweaks like a new button, badge, shortcut or error message, since consistency is what these rules protect.
---

# Digestor UI

## Status of the design (read first)

The UI concept was **agreed on 2026-10-30** and Plan 2 built it. The source of truth is `docs/superpowers/specs/2026-10-30-digestor-ui-concept-design.md` (§5 is the journalist flow; §8 is the Tracker, still to come in Plan 4).

- **The flow and stepper:** Upload › Processing › Context › Preview › Briefing › Prepare › Export (`STEPS` in `components/AppBar.tsx`). Routes: `/` upload, `/s/[id]` (Processing, Context check, then **Preview** once ready), `/s/[id]/briefing` (**Full briefing**), `/s/[id]/prepare` (**Prepare clips**), `/s/[id]/export`, `/reports`. The v1 review inbox and `ClipCard` no longer exist.
- **Preview** (`components/Preview/`): session timeline with neutral topic bands and highlight pins, top-highlight cards, then the briefing document. **Full briefing** (`components/Briefing/`): instant filters, keyboard triage, "Confirm selection → Prepare clips". **Prepare** (`components/Prepare/`): trim, checks, format, credit, subtitles, checklist.
- Mockups in `docs/design/` (`ui-concept-overview.html`, `ui-concept-tracker.html`) are inspiration, not a pixel spec; the Tracker is Plan 4.
- **Colour is reserved for highlight types**; topic bands are neutral greys. AI judgments carry an "AI" badge and a "Why:" line, counted values read "counted", and names show their source.
- If a task needs a design decision the spec doesn't answer, propose 1–2 options with a quick screenshot or sketch and ask. Don't silently invent the concept.

## Visual language (as implemented)

Tokens live in `apps/web/app/globals.css` (`:root`) and match the mockups' palette:

| Role | Token / Tailwind | Value |
|---|---|---|
| Page background | `bg-background` | `#f6f5f2` (warm off-white) |
| Ink | `text-foreground`, `bg-primary` | `#17181c` |
| Muted text | `text-muted-foreground` | `#71727a` |
| Lines | `border-border` | `#e9e6df` |
| Brand / primary action | `bg-brand text-brand-foreground` | `#ff5a36` |
| Cards | `bg-white` / `bg-card`, `rounded-xl border border-border` | white |

Font: Inter (`--font-inter`) for UI, Geist Mono for times/numbers where alignment matters. Radius base `0.625rem`.

Use tokens, not new hex literals. Highlight colours live in one place: each type's `tone` in `HIGHLIGHT_TYPES` (`packages/core/src/profiles.ts`), rendered by `components/HighlightChip.tsx`. Never copy chip classes; render a `HighlightChip`. Pins, legend and cards all use it.

**Colour has meaning — keep it consistent:**

| Meaning | Colour | Where |
|---|---|---|
| Highlight type | the type's `tone` (red, blue, amber, violet, green, teal, slate, pink) | `HighlightChip`, timeline pins, legend |
| Approved | green | status buttons, "Approved ✓" |
| Rejected / error | red | status buttons, `role="alert"` boxes |
| Warning | **neutral + ⚠**: stone border/background (`WARNING_BOX`) with the ⚠ icon (`WarningIcon`) and text — never amber (amber is a highlight tone) | `components/WarningNote.tsx`: clip checks, sensitive-profile notice, audio-only upload, "out of date", "Subtitles are for the old cut." |
| Human-in-the-loop, "from you" | purple | context badge, edited facts, the pause screens' accent |
| Source badges | "from video" / "from audio" green; "from metadata" grey; "from you" purple; "suggested by AI" neutral; "missing" red | context check and context banner (`lib/contextBadge.ts`) |
| AI-judged item | "AI" badge on the chip, plus a "Why:" line | Preview, Full briefing |
| Counted value | "counted" badge | e.g. "Most discussed" |

Colour is never the only signal: every chip/badge carries text.

## Components and layout

- shadcn (style `base-nova`, on **Base UI**, not Radix) in `components/ui/` (badge, button, card, checkbox, dialog, input, progress, tabs, textarea, and the later additions: check `components/ui/`); add new primitives with `pnpm --filter @digestor/web exec shadcn add <name>` and keep `cn()` from `lib/utils.ts`. Icons: `lucide-react`.
- Screen frame: `AppBar` with the stepper **Upload › Processing › Context › Preview › Briefing › Prepare › Export** (current step bold, done steps green with ✓), then `<main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">` with an `h1` title.
- Full briefing and Prepare have a sticky bottom bar with the primary action ("Confirm selection → Prepare clips", "Export ready clips →").
- Primary action = brand button, right/bottom; secondary = text-style link or outline button ("Something's off").
- Text comes from the typed catalogue `apps/web/messages/en.ts` via `t()` (`lib/i18n.ts`); add strings there, never inline.
- Pages are server components; interactive parts are `"use client"` components that receive data as props (see `nextjs16-gotchas`).

## Copy

- Spec-exact strings: each type's label from `HIGHLIGHT_TYPES` (e.g. "Heated", "Key point", "Light moment"); statuses Approve / Neutral / Reject; "Looks right → Full briefing", "Something's off", "Copy text", "Share link", "Export…", "Confirm selection → Prepare clips", "Report a problem"; Export notice "You're responsible for how you use and share downloaded clips."
- Footer of the Full briefing: "N approved · M hidden by filters" with a "Show hidden" button. Approved moments are never hidden.
- AI reasons start with "Why:". Questions say why they're asked.
- Errors are friendly, specific sentences shown **inline** next to what failed (`role="alert"`); success/progress uses `role="status"`. Never show raw errors, stack traces or vendor messages the user can't act on.
- Times: `m:ss` for durations, `hh:mm:ss` for positions in the video; inputs accept what `parseTimestamp` accepts.

## Keyboard

Full briefing shortcuts (global `keydown` in `components/Briefing/FullBriefing.tsx`, logic in `lib/review.ts`): `A` approve, `N` neutral, `R` reject, `E` open in Prepare clips, `↓`/`↑` move focus. `/` opens the Ask drawer on Preview and Full briefing. Rules that already cost a fix round:

- Ignore keys while typing (`isTyping`), with modifiers, while a dialog is open, or when `defaultPrevented`.
- Ignore `e.repeat` for status keys (holding `A` must not approve a run of moments); arrows may repeat.
- Status changes per moment are serialised latest-wins (`lib/statusQueue.ts`); Confirm waits for `StatusQueue.idle()`.
- Show the shortcuts as `kbd` hints on buttons and in the footer legend. New shortcuts must not collide.
- Trim: Alt/Option previews free handle positions only; the server always snaps to sentence boundaries (help text says so).

## Accessibility

- The focused moment uses real roving focus plus a polite live region announcing status changes ("Approved: <title>"); keep both when touching the list.
- Buttons carry the item title in their accessible name (`aria-label="Approve: <title>"`); every icon-only button needs `aria-label`.
- Keep visible focus rings, AA contrast (muted text on off-white is the tightest case), and respect `prefers-reduced-motion`.

## Content in many languages

Videos, quotes, clip titles and subtitles are in the **spoken language** (Portuguese, Russian, Japanese, Arabic…), while the UI chrome is English.

- Inter is loaded with the `latin` subset only: Cyrillic/CJK/Arabic fall back to system fonts — check they render acceptably and add subsets (or Noto) if not.
- Put `lang` (and `dir="auto"`) on elements that show transcript text or titles so screen readers and line breaking behave; never truncate in a way that splits a grapheme.
- Download filenames use RFC 5987 `filename*` with an ASCII fallback (files route).

## Media

Players use the 480p proxy (`/api/files/<id>/proxy.mp4`, Range-enabled) with `preload="none"` and `#t=start,end` fragments for previews; thumbnails are `/api/files/<id>/thumbs/<clipId>.jpg`. Never point a player at `original.*`.

## Plan 2 pieces (built)

- **Ask drawer** (`components/Ask/`, `/` opens it): answers only from stored data, with clickable `[hh:mm:ss]` timestamps. Tool calls show as small chips with Undo. Edits touch only the personal layer; bulk changes need confirmation; Undo never reverts later changes you made.
- **Prepare clips:** a zoomed trim strip whose handles snap to sentence pauses; checks ("The argument continues" + Extend, "Context:", "Quoting someone else", "Interpreter audio"); 16:9 or 9:16 with a crop offset; the credit line (or "No credit needed"); per-language subtitles with review, approval and burn-in; and the "Before export" checklist.
- **Source badges** on names (Plan 3) read "from record", "from caption", "from voice", "from you"; a name with no source is never shown.

## Verify every UI change

1. Run the `digestor-run` skill: seed the relevant stage, screenshot at 1280 px and 390 px (`--mobile`), press the keys you touched, and **look at the PNGs**. `errors.txt` must be empty.
2. Check: stepper state, chip colour/label mapping, exact copy, no horizontal overflow at 390 px, errors inline, focus visible when tabbing. Full-page shots show a sticky bottom bar mid-page; that is a capture artefact, not a bug.
3. Logic that can be pulled out of components (`lib/review.ts`, `lib/briefingFilters.ts`, `lib/statusQueue.ts`, `lib/contextPayload.ts`) gets vitest tests; web tests run in the `node` environment — there is no DOM test setup yet, so propose one (jsdom + Testing Library) before writing component tests.
