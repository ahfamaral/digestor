import { CHAMBER_IDS, PROFILES, ProfileIdSchema, chamberLabel, type ChamberId, type ProfileId } from "@digestor/core";
import type { SessionSummary } from "@digestor/core/server";
import type { Step } from "@/components/AppBar";
import { t } from "@/lib/i18n";
import { sessionStatus } from "@/lib/sessionList";

/** A session summary as the Sessions page gets it (dates as ISO strings across the server/client boundary). */
export type HomeRow = Omit<SessionSummary, "createdAt" | "lastActivityAt"> & { createdAt: string; lastActivityAt: string };

export type StatusFilter = "any" | "needs_you" | "to_export" | "processing" | "failed" | "ready";
export type BodyFilter = ChamberId | "unlinked" | "all";

export interface HomeFilters {
  type: ProfileId | "all";
  body: BodyFilter;
  status: StatusFilter;
  q: string;
  clips: boolean;
  recent: boolean;
}

export const DEFAULT_FILTERS: HomeFilters = { type: "all", body: "all", status: "any", q: "", clips: false, recent: false };

const STATUSES: StatusFilter[] = ["any", "needs_you", "to_export", "processing", "failed", "ready"];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Filters from the page's query string; unknown values fall back to the defaults. */
export function parseFilters(query: Record<string, string | string[] | undefined>): HomeFilters {
  const type = ProfileIdSchema.safeParse(one(query.type));
  const status = one(query.status);
  const body = one(query.body);
  const f: HomeFilters = {
    type: type.success ? type.data : "all",
    body: body === "unlinked" || (CHAMBER_IDS as string[]).includes(body ?? "") ? (body as BodyFilter) : "all",
    status: STATUSES.includes(status as StatusFilter) ? (status as StatusFilter) : "any",
    q: one(query.q) ?? "",
    clips: one(query.clips) === "1",
    recent: one(query.recent) === "1",
  };
  if (f.type !== "parliament") f.body = "all";
  return f;
}

/** The query string for these filters (defaults left out; a body only on the Parliament tab). */
export function filtersToQuery(f: HomeFilters): string {
  const p = new URLSearchParams();
  if (f.type !== "all") p.set("type", f.type);
  if (f.type === "parliament" && f.body !== "all") p.set("body", f.body);
  if (f.status !== "any") p.set("status", f.status);
  if (f.q !== "") p.set("q", f.q);
  if (f.clips) p.set("clips", "1");
  if (f.recent) p.set("recent", "1");
  return p.toString();
}

/** Clips still to render, while the video can still be rendered. */
export function toExport(row: HomeRow): boolean {
  return row.stage === "ready" && !row.videoRemoved && row.clipCount > row.renderedClips;
}

/** The one status bucket a session is in. */
export function bucket(row: HomeRow): Exclude<StatusFilter, "any" | "to_export"> {
  if (row.stage === "ready") return "ready";
  if (row.stage === "awaiting_context") return "needs_you";
  if (row.stage === "failed") return "failed";
  return "processing";
}

/** Where the session is, in plain words, and where its row leads. Never shows the raw error. */
export function whereItIs(row: HomeRow): { text: string; tone: "normal" | "waiting" | "failed" | "busy"; href: string } {
  const base = `/s/${row.id}`;
  switch (bucket(row)) {
    case "ready":
      return row.clipCount > 0
        ? { text: t("home.wherePrepare"), tone: "normal", href: `${base}/prepare` }
        : { text: t("home.whereBriefing"), tone: "normal", href: base };
    case "needs_you":
      return { text: t("home.whereContext"), tone: "waiting", href: base };
    case "failed":
      return { text: t("home.statusFailed"), tone: "failed", href: base };
    default:
      return { text: t("home.whereBusy", { label: sessionStatus(row).text, progress: row.progress }), tone: "busy", href: base };
  }
}

/** The steps a row links to; `href: null` is shown dimmed (Prepare and Export before there are clips). */
export function goTo(row: HomeRow): { step: Extract<Step, "Briefing" | "Prepare" | "Export" | "Context" | "Processing">; href: string | null }[] {
  const base = `/s/${row.id}`;
  switch (bucket(row)) {
    case "ready": {
      const clips = row.clipCount > 0;
      return [
        { step: "Briefing", href: base },
        { step: "Prepare", href: clips ? `${base}/prepare` : null },
        { step: "Export", href: clips ? `${base}/export` : null },
      ];
    }
    case "needs_you":
      return [{ step: "Context", href: base }];
    case "processing":
      return [{ step: "Processing", href: base }];
    default:
      return [];
  }
}

/** The counts on the "needs you" strip. */
export function needsYou(rows: HomeRow[]): { needs_you: number; to_export: number; failed: number; processing: number } {
  const out = { needs_you: 0, to_export: 0, failed: 0, processing: 0 };
  for (const r of rows) {
    const b = bucket(r);
    if (b !== "ready") out[b]++;
    if (toExport(r)) out.to_export++;
  }
  return out;
}

const profileOf = (row: HomeRow): ProfileId | null => {
  const p = ProfileIdSchema.safeParse(row.profile);
  return p.success ? p.data : null;
};

/** "All" first, then one tab per kind of video present, in the profiles' own order. */
export function typeTabs(rows: HomeRow[]): { id: ProfileId | "all"; label: string; count: number }[] {
  const tabs: { id: ProfileId | "all"; label: string; count: number }[] = [{ id: "all", label: t("home.tabAll"), count: rows.length }];
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const count = rows.filter((r) => profileOf(r) === id).length;
    if (count > 0) tabs.push({ id, label: PROFILES[id].label, count });
  }
  return tabs;
}

/** Body chips for the Parliament tab: houses with sessions, then the parliament sessions with no linked record. */
export function bodyChips(rows: HomeRow[]): { id: BodyFilter; label: string; count: number }[] {
  const parl = rows.filter((r) => profileOf(r) === "parliament");
  const chips: { id: BodyFilter; label: string; count: number }[] = [{ id: "all", label: t("home.bodyAll"), count: parl.length }];
  for (const id of CHAMBER_IDS) {
    const count = parl.filter((r) => r.chamber === id).length;
    if (count > 0) chips.push({ id, label: chamberLabel(id), count });
  }
  const unlinked = parl.filter((r) => r.chamber === null).length;
  if (unlinked > 0) chips.push({ id: "unlinked", label: t("home.bodyUnlinked"), count: unlinked });
  return chips;
}

const ADDED = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });

/** "Nov 4": the day a session was added, in UTC so the server render and the browser agree (no hydration mismatch). */
export function addedDate(iso: string): string {
  return ADDED.format(new Date(iso));
}

/** The rows in the current tab and Body, whatever the other filters say: the scope the needs-you counts follow. */
export function scopeRows(rows: HomeRow[], f: HomeFilters): HomeRow[] {
  return filterRows(rows, { ...DEFAULT_FILTERS, type: f.type, body: f.body }, new Date(0));
}

const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export function filterRows(rows: HomeRow[], f: HomeFilters, now: Date): HomeRow[] {
  const q = fold(f.q);
  return rows.filter((r) => {
    if (f.type !== "all" && profileOf(r) !== f.type) return false;
    if (f.type === "parliament" && f.body !== "all" && (f.body === "unlinked" ? r.chamber !== null : r.chamber !== f.body)) return false;
    if (f.status === "to_export" ? !toExport(r) : f.status !== "any" && bucket(r) !== f.status) return false;
    if (f.clips && r.clipCount === 0) return false;
    if (f.recent && now.getTime() - new Date(r.createdAt).getTime() > WEEK_MS) return false;
    if (q !== "" && !fold(r.title).includes(q)) return false;
    return true;
  });
}

/** The Clips cell: "—" before the briefing, then "none yet", "1", "8 · 1 rendered". */
export function clipCellText(row: HomeRow): string {
  if (row.stage !== "ready") return "—";
  if (row.clipCount === 0) return t("home.clipsNone");
  return row.renderedClips > 0 ? t("home.clipsRendered", { n: row.clipCount, r: row.renderedClips }) : String(row.clipCount);
}
