import {
  GranularitySchema, HighlightTypeIdSchema, type Granularity, type HighlightTypeId, type MomentWithHighlights, type SelectionStatus,
  type Topic,
} from "@digestor/core";

export const SHOW_FILTERS = ["open", "all", "approved", "neutral", "rejected"] as const;
/** Which statuses are listed. `open` = proposed or approved (neutral and rejected are put aside). */
export type ShowFilter = (typeof SHOW_FILTERS)[number];

export interface BriefingFilters {
  granularity: Granularity;
  /** Diarized speaker id ("A", "B"…) that must speak in the moment, or null for everyone. */
  speaker: string | null;
  /** Person id who must speak (at least FOCUS_MIN_MS of the moment's words) in the moment, or null. Exclusive with `speaker`. */
  person: string | null;
  /** 0–100; counted and personal moments ignore it. */
  minRelevance: number;
  /** Moments with any of these highlight types; empty = all types. */
  types: HighlightTypeId[];
  show: ShowFilter;
}

export const DEFAULT_FILTERS: BriefingFilters = { granularity: "exchange", speaker: null, person: null, minRelevance: 0, types: [], show: "open" };
/** "Show hidden": every approved moment, nothing else narrowing the list. */
export const SHOW_HIDDEN_FILTERS: BriefingFilters = { ...DEFAULT_FILTERS, show: "approved" };

export interface MomentView {
  moment: MomentWithHighlights;
  /** null = proposed (no selection row). */
  status: SelectionStatus | null;
  children: MomentView[];
}

/** Coarse → fine: a level shows itself and the levels after it. */
const LEVEL: Record<Granularity, number> = { exchange: 0, passage: 1, punchline: 2 };

const isPersonal = (m: MomentWithHighlights) => m.origin === "ask" || m.origin === "user" || m.origin === "find_more";

/** What the person check needs: the people speaking at least FOCUS_MIN_MS in each moment, built once (`peopleByMoment`). */
export interface FocusContext {
  peopleByMoment: Map<string, Set<string>>;
}

/** Every filter except the granularity floor (speaker, person, relevance, types, status). */
function passesContent(m: MomentWithHighlights, status: SelectionStatus | null, f: BriefingFilters, ctx: FocusContext): boolean {
  if (f.person !== null && !ctx.peopleByMoment.get(m.id)?.has(f.person)) return false;
  if (f.speaker !== null && !m.speakers.includes(f.speaker)) return false;
  // Counted values aren't AI judgments, and Ask/user moments carry no score: the relevance floor is for model-scored picks.
  if ((m.origin === "ai" || m.origin === "find_more") && m.relevance < f.minRelevance) return false;
  if (f.types.length > 0 && !m.highlights.some((h) => f.types.includes(h.type))) return false;
  switch (f.show) {
    case "all":
      return true;
    case "open":
      return status === null || status === "approved";
    default:
      return status === f.show;
  }
}

type TopicSpan = Pick<Topic, "id" | "startMs" | "endMs">;

/** Index of the moment's topic: its `topicId`, else the topic covering its start; -1 when none. */
function topicIndex(m: Pick<MomentWithHighlights, "topicId" | "startMs">, topics: TopicSpan[]): number {
  const i = m.topicId ? topics.findIndex((t) => t.id === m.topicId) : -1;
  return i >= 0 ? i : topics.findIndex((t) => m.startMs >= t.startMs && m.startMs < t.endMs);
}

/**
 * The moments the filters show, as a tree. The selected granularity is the primary list; finer moments nest under
 * their `insideMomentId` parent when that parent is shown. A finer moment whose parent is filtered out is listed on
 * its own only when its level is the selected one; otherwise it is hidden. Personal moments are never nested.
 * Approved work is never invisible (Ruling R23): an approved moment that passes every other filter but would be hidden
 * by its level or a missing parent is listed flat, at the top of its topic's rows; `show=approved` lists every approved
 * moment flat, ignoring granularity and nesting.
 * Order: by topic (`topics` order; a moment without a known topic goes with the topic covering its start), then start.
 */
export function filterMoments(
  moments: MomentWithHighlights[],
  selections: Record<string, SelectionStatus>,
  f: BriefingFilters,
  topics: TopicSpan[] = [],
  ctx: FocusContext = { peopleByMoment: new Map() },
): MomentView[] {
  const flat = f.show === "approved";
  // Moments at or below the selected level that pass every filter: these build the tree.
  const shown = new Map<string, MomentView>();
  const roots: MomentView[] = [];
  for (const m of moments) {
    const status = selections[m.id] ?? null;
    if (!passesContent(m, status, f, ctx)) continue;
    const view = { moment: m, status, children: [] };
    if (flat) roots.push(view);
    else if (LEVEL[m.granularity] >= LEVEL[f.granularity]) shown.set(m.id, view);
    else if (status === "approved") roots.push(view); // coarser than the level, but approved: listed flat, never a parent
  }
  for (const v of shown.values()) {
    const parentId = isPersonal(v.moment) ? null : v.moment.insideMomentId;
    const found = parentId !== null ? shown.get(parentId) : undefined;
    // Only a coarser moment can hold a finer one, so bad data can't make a nesting cycle that hides both.
    const parent = found && LEVEL[found.moment.granularity] < LEVEL[v.moment.granularity] ? found : undefined;
    if (parent) parent.children.push(v);
    else if (v.moment.granularity === f.granularity || v.status === "approved") roots.push(v);
  }
  const topicRank = (m: MomentWithHighlights) => {
    const i = topicIndex(m, topics);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const byStart = (a: MomentView, b: MomentView) => a.moment.startMs - b.moment.startMs || a.moment.id.localeCompare(b.moment.id);
  const sortChildren = (v: MomentView) => {
    v.children.sort(byStart);
    v.children.forEach(sortChildren);
  };
  roots.forEach(sortChildren);
  return roots.sort((a, b) => topicRank(a.moment) - topicRank(b.moment) || byStart(a, b));
}

/** How many of the approved moments (`approvedIds`) the filtered tree doesn't show: the footer's "M hidden by filters". */
export function hiddenApprovedCount(views: MomentView[], approvedIds: string[]): number {
  const visible = new Set<string>();
  const walk = (list: MomentView[]) => {
    for (const v of list) {
      visible.add(v.moment.id);
      walk(v.children);
    }
  };
  walk(views);
  return approvedIds.filter((id) => !visible.has(id)).length;
}

/** `filterMoments` output split into topic sections (topic order); moments outside every topic come last, with `topic: null`. */
export function groupByTopic<T extends TopicSpan>(views: MomentView[], topics: T[]): { topic: T | null; views: MomentView[] }[] {
  const groups = new Map<number, MomentView[]>();
  for (const v of views) {
    const i = topicIndex(v.moment, topics);
    groups.set(i, [...(groups.get(i) ?? []), v]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < 0 ? Infinity : a) - (b < 0 ? Infinity : b))
    .map(([i, list]) => ({ topic: topics[i] ?? null, views: list }));
}

/** The filters as a query string without `?` (defaults omitted): `g=passage&s=B&r=40&t=heated,laughter&show=all`. */
export function toSearchParams(f: BriefingFilters): string {
  const parts: string[] = [];
  if (f.granularity !== DEFAULT_FILTERS.granularity) parts.push(`g=${f.granularity}`);
  if (f.speaker !== null) parts.push(`s=${encodeURIComponent(f.speaker)}`);
  if (f.person !== null) parts.push(`p=${encodeURIComponent(f.person)}`);
  if (f.minRelevance !== DEFAULT_FILTERS.minRelevance) parts.push(`r=${f.minRelevance}`);
  if (f.types.length > 0) parts.push(`t=${f.types.join(",")}`);
  if (f.show !== DEFAULT_FILTERS.show) parts.push(`show=${f.show}`);
  return parts.join("&");
}

/** Filters read back from the URL. Unknown or invalid values fall back to the defaults; with `speakers` / `persons`, an unknown one too. A person wins over a speaker. */
export function fromSearchParams(params: { get(name: string): string | null }, known: { speakers?: string[]; persons?: string[] } = {}): BriefingFilters {
  const g = GranularitySchema.safeParse(params.get("g"));
  const s = params.get("s");
  const p = params.get("p");
  const person = p && (!known.persons || known.persons.includes(p)) ? p : null;
  const r = params.get("r") ?? "";
  const relevance = /^\d{1,3}$/.test(r) ? Number(r) : NaN;
  const types = [
    ...new Set(
      (params.get("t") ?? "")
        .split(",")
        .map((x) => HighlightTypeIdSchema.safeParse(x.trim()))
        .flatMap((x) => (x.success ? [x.data] : [])),
    ),
  ];
  const show = SHOW_FILTERS.find((x) => x === params.get("show"));
  return {
    granularity: g.success ? g.data : DEFAULT_FILTERS.granularity,
    speaker: !person && s && (!known.speakers || known.speakers.includes(s)) ? s : DEFAULT_FILTERS.speaker,
    person,
    minRelevance: relevance >= 0 && relevance <= 100 ? relevance : DEFAULT_FILTERS.minRelevance,
    types,
    show: show ?? DEFAULT_FILTERS.show,
  };
}
