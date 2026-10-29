---
name: digestor-ui
description: Frontend conventions for Digestor's web UI — visual tokens, semantic colours, shadcn/Base UI components, layout, exact copy, keyboard triage, accessibility, multilingual content and how to verify a screen. Use this before building or changing any screen or component in apps/web (upload, processing, context check, review inbox, edit-times dialog, export, login) and for every Plan 2 UI piece (copilot drawer, heat timeline, trim handles, speaker labels) — also for small tweaks like a new button, badge, shortcut or error message, since consistency is what these rules protect.
---

# Digestor UI

## Status of the design (read first)

The real UI concept is **not decided yet** — the owner will discuss it, starting from the walkthrough mockups. Until then:

- **The current code is the baseline.** Extend it consistently; don't restyle screens or swap patterns on your own initiative.
- **The mockups are inspiration only**: `docs/design/walkthrough-mockups.html` (open it in a browser; tabs 1–6). Use them for intent and tone (light, calm, card-based; the human always decides; sources are visible), not as a pixel spec. Where code and mockup differ, the code wins until the owner says otherwise.
- If a task needs a design decision the code doesn't answer (a new screen, a new interaction model, the Plan 2 timeline/copilot), propose 1–2 options with a quick screenshot or sketch and ask — don't silently invent the concept.

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

Use tokens, not new hex literals. The label colours in `components/ClipCard.tsx` (`LABELS`) are the one place hex lives today — reuse `LABELS` rather than copying its classes.

**Colour has meaning — keep it consistent:**

| Meaning | Colour | Where |
|---|---|---|
| Heated | orange-red chip | `LABELS.heated` |
| Key point | blue chip | `LABELS.key_point` |
| Light moment | amber chip | `LABELS.light` |
| Approved | green | status buttons, filter chip |
| Rejected / error | red | status buttons, `role="alert"` boxes |
| Human-in-the-loop, "from you" | purple | context badge, edited facts, the pause screens' accent |
| Fact from video / audio | green badge "from video" / "from audio" |
| Fact from metadata | grey badge "from metadata" |
| Missing fact | red badge "missing" |

Colour is never the only signal: every chip/badge carries text.

## Components and layout

- shadcn (style `base-nova`, on **Base UI**, not Radix) in `components/ui/` (badge, button, card, checkbox, dialog, input, progress, tabs, textarea); add new primitives with `pnpm --filter @digestor/web exec shadcn add <name>` and keep `cn()` from `lib/utils.ts`. Icons: `lucide-react`.
- Screen frame: `AppBar` with the stepper **Upload › Processing › Context › Review › Export** (current step bold, done steps green with ✓), then `<main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">` with an `h1` title.
- The inbox owns its app bar (the right-hand "Render N approved →" button follows live triage state).
- Primary action = brand button, right/bottom; secondary = text-style link ("Skip — find clips anyway").
- Pages are server components; interactive parts are `"use client"` components that receive data as props (see `nextjs16-gotchas`).

## Copy

- Spec-exact strings: labels "Heated", "Key point", "Light moment"; statuses Approve / Neutral / Reject; Export notice "You're responsible for how you use and share downloaded clips."
- AI reasons start with "Why:". Questions say why they're asked.
- Errors are friendly, specific sentences shown **inline** next to what failed (`role="alert"`); success/progress uses `role="status"`. Never show raw errors, stack traces or vendor messages the user can't act on.
- Times: `m:ss` for durations, `hh:mm:ss` for positions in the video; inputs accept what `parseTimestamp` accepts.

## Keyboard

Inbox shortcuts (global `keydown` in `components/Inbox.tsx`): `A` approve, `N` neutral, `R` reject, `E` edit times, `↓`/`↑` move focus. Rules that already cost a fix round:

- Ignore keys while typing (`isTyping`), with modifiers, while a dialog is open, or when `defaultPrevented`.
- Ignore `e.repeat` for status keys (holding `A` must not approve a run of clips); arrows may repeat.
- Status changes per clip are serialised latest-wins (`lib/statusQueue.ts`); Render waits for `StatusQueue.idle()`.
- Show the shortcuts as `kbd` hints on buttons and in the footer legend. New shortcuts must not collide; `/` is reserved for the copilot (mockup).

## Accessibility (known gaps — fix when touching these areas)

- The inbox's focused clip is a visual "virtual focus" not announced to screen readers → use roving `tabIndex` (real focus) or `aria-activedescendant`, plus a polite live region announcing status changes.
- Some buttons have generic accessible names ("Approve" ×N) → include the clip title (`aria-label="Approve: <title>"`); every icon-only button needs `aria-label`.
- Keep visible focus rings, AA contrast (muted text on off-white is the tightest case), and respect `prefers-reduced-motion`.

## Content in many languages

Videos, quotes, clip titles and subtitles are in the **spoken language** (Portuguese, Russian, Japanese, Arabic…), while the UI chrome is English.

- Inter is loaded with the `latin` subset only: Cyrillic/CJK/Arabic fall back to system fonts — check they render acceptably and add subsets (or Noto) if not.
- Put `lang` (and `dir="auto"`) on elements that show transcript text or titles so screen readers and line breaking behave; never truncate in a way that splits a grapheme.
- Filenames for downloads with non-ASCII titles currently become `clip.mp4` (Plan 2 backlog: `filename*`).

## Media

Players use the 480p proxy (`/api/files/<id>/proxy.mp4`, Range-enabled) with `preload="none"` and `#t=start,end` fragments for previews; thumbnails are `/api/files/<id>/thumbs/<clipId>.jpg`. Never point a player at `original.*`.

## Plan 2 pieces (inspiration only — concept to be agreed)

The mockups sketch: a **copilot drawer** in the inbox (questions answered with clickable timestamps; tool calls shown as small "⚙ tool(args)" lines; every edit reversible with Undo and still subject to approval), an **edit-cut view** with a whole-video heat curve and a zoomed trim strip whose handles snap to pause lines, and **speaker labels** as an optional render checkbox (a name with no source is never shown). Treat these as starting points for the design discussion, not as specs.

## Verify every UI change

1. Run the `digestor-run` skill: seed the relevant stage, screenshot at 1280 px and 390 px (`--mobile`), press the keys you touched, and **look at the PNGs**. `errors.txt` must be empty.
2. Check: stepper state, label/colour mapping, exact copy, no horizontal overflow at 390 px, errors inline, focus visible when tabbing.
3. Logic that can be pulled out of components (`lib/review.ts`, `lib/statusQueue.ts`, `lib/contextPayload.ts`) gets vitest tests; web tests run in the `node` environment — there is no DOM test setup yet, so propose one (jsdom + Testing Library) before writing component tests.
