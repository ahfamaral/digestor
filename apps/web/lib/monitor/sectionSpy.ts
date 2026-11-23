/**
 * The section being read under a sticky section bar: the last section whose top has passed `line` (the bar's bottom),
 * or the last section once the page can't scroll further (a short last section never reaches the line). Sections not
 * on the page (`top` null) are skipped; null before the first section.
 */
export function currentSection(tops: { id: string; top: number | null }[], line: number, atEnd = false): string | null {
  const present = tops.filter((s): s is { id: string; top: number } => s.top !== null);
  if (atEnd && present.length > 0 && present[present.length - 1]!.top < line + 400) return present[present.length - 1]!.id;
  let current: string | null = null;
  for (const s of present) if (s.top <= line) current = s.id;
  return current;
}
