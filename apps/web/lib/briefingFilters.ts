import {
  HighlightTypeIdSchema, type Granularity, type HighlightTypeId, type MomentWithHighlights, type SelectionStatus,
  type Topic,
} from "@digestor/core";

export const SHOW_FILTERS = ["open", "all", "approved", "skipped"] as const;
/** Which statuses are listed. `open` = proposed or approved (skipped moments are put aside). */
export type ShowFilter = (typeof SHOW_FILTERS)[number];

export interface BriefingFilters {
  /** The ticked levels: a moment at an unticked level is not listed (unless approved); its children nest under the nearest listed ancestor. */
  levels: Granularity[];
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

const ALL_LEVELS: Granularity[] = ["exchange", "passage", "punchline"];
/**
 * The levels ticked when the URL says nothing: Exchanges and Passages. Punchlines are many (hundreds in a long
 * interview) and nest inside the passages, so they start unticked; approved punchlines still show (R23).
 */
export const DEFAULT_LEVELS: readonly Granularity[] = ["exchange", "passage"];

export const DEFAULT_FILTERS: BriefingFilters = { levels: [...DEFAULT_LEVELS], speaker: null, person: null, minRelevance: 0, types: [], show: "open" };
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

/**
 * Every filter except the levels (speaker, person, relevance, types, status). `sticky` skips the status filter only.
 * An approved moment skips the content filters too: approved work is never hidden by a filter (only by the status tab).
 */
function passesContent(m: MomentWithHighlights, status: SelectionStatus | null, f: BriefingFilters, ctx: FocusContext, sticky: boolean): boolean {
  const approved: boolean = status === "approved";
  if (approved) return sticky || f.show !== "skipped";
  if (f.person !== null && !ctx.peopleByMoment.get(m.id)?.has(f.person)) return false;
  if (f.speaker !== null && !m.speakers.includes(f.speaker)) return false;
  // Counted values aren't AI judgments, and Ask/user moments carry no score: the relevance floor is for model-scored picks.
  if ((m.origin === "ai" || m.origin === "find_more") && m.relevance < f.minRelevance) return false;
  if (f.types.length > 0 && !m.highlights.some((h) => f.types.includes(h.type))) return false;
  if (sticky) return true;
  switch (f.show) {
    case "all":
      return true;
    case "open":
      return status === null || status === "approved";
    case "approved":
      return status === "approved";
    case "skipped":
      return status === "rejected";
  }
}

type TopicSpan = Pick<Topic, "id" | "startMs" | "endMs">;

/** Index of the moment's topic: its `topicId`, else the topic covering its start; -1 when none. */
function topicIndex(m: Pick<MomentWithHighlights, "topicId" | "startMs">, topics: TopicSpan[]): number {
  const i = m.topicId ? topics.findIndex((t) => t.id === m.topicId) : -1;
  return i >= 0 ? i : topics.findIndex((t) => m.startMs >= t.startMs && m.startMs < t.endMs);
}

/**
 * The moments the filters show, as a tree. A moment is listed when it passes the content and status filters and its
 * level is ticked or it is approved (Ruling R23: approved work is never hidden by a level). `sticky` ids (rows decided
 * during this visit) skip the status filter only. Each listed official moment nests under its nearest listed
 * coarser ancestor (walking `insideMomentId` with a visited set); with none it is a root of its topic. Personal moments
 * (`ask`, `user`, `find_more`) are always roots. A moment is never hidden because of its parent, whatever the data
 * (self-reference, missing, finer parent, cycle).
 * Order: by topic (`topics` order; a moment without a known topic goes with the topic covering its start), then start.
 */
export function filterMoments(
  moments: MomentWithHighlights[],
  selections: Record<string, SelectionStatus>,
  f: BriefingFilters,
  topics: TopicSpan[] = [],
  ctx: FocusContext = { peopleByMoment: new Map() },
  sticky?: ReadonlySet<string>,
): MomentView[] {
  const byId = new Map(moments.map((m) => [m.id, m]));
  const listed = new Map<string, MomentView>();
  for (const m of moments) {
    const status = selections[m.id] ?? null;
    if (!passesContent(m, status, f, ctx, sticky?.has(m.id) ?? false)) continue;
    if (!f.levels.includes(m.granularity) && status !== "approved") continue;
    listed.set(m.id, { moment: m, status, children: [] });
  }
  const roots: MomentView[] = [];
  for (const v of listed.values()) {
    let parent: MomentView | undefined;
    if (!isPersonal(v.moment)) {
      const seen = new Set([v.moment.id]);
      for (let id = v.moment.insideMomentId; id !== null && !seen.has(id); id = byId.get(id)?.insideMomentId ?? null) {
        seen.add(id);
        const up = listed.get(id);
        // Only a coarser moment can hold a finer one, so bad data can't make a nesting cycle that hides both.
        if (up && LEVEL[up.moment.granularity] < LEVEL[v.moment.granularity]) {
          parent = up;
          break;
        }
      }
    }
    if (parent) parent.children.push(v);
    else roots.push(v);
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

/** The filters as a query string without `?` (defaults omitted): `lv=passage&s=B&r=40&t=heated,laughter&show=all`. */
export function toSearchParams(f: BriefingFilters): string {
  const parts: string[] = [];
  const levels = ALL_LEVELS.filter((l) => f.levels.includes(l));
  if (levels.join(",") !== DEFAULT_LEVELS.join(",")) parts.push(`lv=${levels.join(",")}`);
  if (f.speaker !== null) parts.push(`s=${encodeURIComponent(f.speaker)}`);
  if (f.person !== null) parts.push(`p=${encodeURIComponent(f.person)}`);
  if (f.minRelevance !== DEFAULT_FILTERS.minRelevance) parts.push(`r=${f.minRelevance}`);
  if (f.types.length > 0) parts.push(`t=${f.types.join(",")}`);
  if (f.show !== DEFAULT_FILTERS.show) parts.push(`show=${f.show}`);
  return parts.join("&");
}

/** Filters read back from the URL. Unknown or invalid values fall back to the defaults; with `speakers` / `persons`, an unknown one too. A person wins over a speaker. */
export function fromSearchParams(params: { get(name: string): string | null }, known: { speakers?: string[]; persons?: string[] } = {}): BriefingFilters {
  const lv = ALL_LEVELS.filter((l) => (params.get("lv") ?? "").split(",").includes(l));
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
    levels: lv.length > 0 ? lv : [...DEFAULT_LEVELS],
    speaker: !person && s && (!known.speakers || known.speakers.includes(s)) ? s : DEFAULT_FILTERS.speaker,
    person,
    minRelevance: relevance >= 0 && relevance <= 100 ? relevance : DEFAULT_FILTERS.minRelevance,
    types,
    show: show ?? DEFAULT_FILTERS.show,
  };
}
