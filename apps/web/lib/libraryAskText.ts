import type { LibraryAskSource } from "@digestor/core";

/** A piece of an answer across videos: text, or one citation `[S2 00:12:03]` of a video at a time. */
export type LibraryAskPart =
  | { kind: "text"; value: string }
  | { kind: "cite"; label: string; time: string; ms: number; source: LibraryAskSource | null; live: boolean };

const BRACKET = /\[([^\]]*)\]/g;
const TOKEN = /\bS(\d+)\b|\b(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\b/g;

/**
 * The answer with each citation found: `[S2 00:12:03]`, several in one bracket (`[S1 00:01:00; S2 00:02:00, 00:03:00]`,
 * a bare time takes the label before it), or a bare `[00:01:00]` when the answer has one source. `live` is false for
 * an unknown label or a source whose session is gone (rendered as plain text, not a link). Brackets without a time
 * stay text.
 */
export function linkifyCitations(text: string, sources: LibraryAskSource[], live: ReadonlySet<string>): LibraryAskPart[] {
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  const parts: LibraryAskPart[] = [];
  let last = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const prev = parts.at(-1);
    if (prev?.kind === "text") prev.value += value;
    else parts.push({ kind: "text", value });
  };
  for (const bracket of text.matchAll(BRACKET)) {
    const cites: Extract<LibraryAskPart, { kind: "cite" }>[] = [];
    let label: string | null = sources.length === 1 ? sources[0]!.label : null;
    for (const t of bracket[1]!.matchAll(TOKEN)) {
      if (t[1] !== undefined) {
        label = `S${t[1]}`;
        continue;
      }
      const [h, m, s] = [Number(t[2] ?? 0), Number(t[3]), Number(t[4])];
      if (label === null || m >= 60 || s >= 60) continue;
      const source = byLabel.get(label) ?? null;
      cites.push({ kind: "cite", label, time: t[0], ms: ((h * 60 + m) * 60 + s) * 1000, source, live: source !== null && live.has(source.sessionId) });
    }
    if (cites.length === 0) continue;
    pushText(text.slice(last, bracket.index));
    cites.forEach((c, i) => {
      if (i > 0) pushText(" ");
      parts.push(c);
    });
    last = bracket.index + bracket[0].length;
  }
  pushText(text.slice(last));
  return parts;
}
