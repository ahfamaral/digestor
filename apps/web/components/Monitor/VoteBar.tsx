import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { voteSegments, type VoteSegment, type VoteSegmentKey } from "@/lib/monitor/voteBar";
import { cn } from "@/lib/utils";

/**
 * Neutral greys only (colour on this site means highlight types and statuses). Sim and Não differ in lightness, which
 * reads the same with any colour vision; the smaller groups add a texture or an outline, and the legend and the counts
 * beside every bar name them, so the fill is never the only signal.
 */
const FILL: Record<VoteSegmentKey, string> = {
  Sim: "bg-stone-800",
  Não: "bg-stone-400",
  Abstenção: "bg-[repeating-linear-gradient(135deg,var(--color-stone-500)_0_1.5px,transparent_1.5px_4px)]",
  Obstrução: "bg-[repeating-linear-gradient(45deg,var(--color-stone-800)_0_1.5px,var(--color-stone-200)_1.5px_4px)]",
  // Dotted, not outlined: a thin outlined sliver at the bar's rounded end read as a letter.
  "Artigo 17": "bg-stone-100 bg-[radial-gradient(var(--color-stone-700)_0.9px,transparent_1.1px)] bg-[length:4px_4px]",
  other: "bg-stone-200 shadow-[inset_0_0_0_1px_var(--color-stone-400)]",
};

const label = (s: { key: VoteSegmentKey }, locale: MonitorLocale) => (s.key === "other" ? tm(locale, "rollCallPage.otherVotes") : s.key);

/**
 * One stacked bar: each segment as wide as its share of this bar's votes (each bar is its own whole). Decorative for
 * assistive technology (`aria-hidden`): the counts printed beside it are the accessible content. Hover shows the count.
 */
export function VoteBar({ counts, locale, className }: { counts: { vote: string; n: number }[]; locale: MonitorLocale; className?: string }) {
  const segs = voteSegments(counts);
  if (segs.length === 0) return null;
  return (
    <span aria-hidden className={cn("flex h-2.5 gap-[2px] overflow-hidden rounded-[4px]", className)}>
      {segs.map((s) => (
        <span
          key={s.key}
          data-vote={s.key}
          title={`${s.key === "other" ? s.votes.join(", ") : s.key} ${formatCount(s.n, locale)}`}
          className={cn("block h-full min-w-[4px]", FILL[s.key])}
          style={{ flexGrow: s.tenths, flexBasis: 0 }}
        />
      ))}
    </span>
  );
}

/** The key for the fills present in `counts`, in bar order (labels only; the counts are printed elsewhere). */
export function VoteLegend({ counts, locale }: { counts: { vote: string; n: number }[]; locale: MonitorLocale }) {
  const segs: VoteSegment[] = voteSegments(counts);
  if (segs.length === 0) return null;
  return (
    <ul aria-hidden lang="pt-BR" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {segs.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className={cn("inline-block size-3 rounded-[3px]", FILL[s.key])} />
          <span lang={s.key === "other" ? locale : undefined}>{label(s, locale)}</span>
        </li>
      ))}
    </ul>
  );
}
