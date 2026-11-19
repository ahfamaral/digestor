import type { LibraryAskSource, LibraryNotSearched, LibraryNotSearchedReason } from "@digestor/core";
import { t } from "@/lib/i18n";

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

/** A block of an answer: a paragraph (its own line breaks kept) or a list made of lines starting "- ", "* " or "• ". */
export type AnswerBlock = { kind: "text"; text: string } | { kind: "list"; items: string[] };

const LIST_LINE = /^\s*[-*•]\s+(.*)$/;

/**
 * The answer's paragraphs and lists: paragraphs are split on blank lines; consecutive list lines (blank lines between
 * them allowed) make one list. Nothing is dropped or reworded.
 */
export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    const joined = para.join("\n").trim();
    if (joined) blocks.push({ kind: "text", text: joined });
    para = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const item = LIST_LINE.exec(line);
    if (item) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === "list") last.items.push(item[1]!.trim());
      else blocks.push({ kind: "list", items: [item[1]!.trim()] });
    } else if (line.trim() === "") {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** A citation with the punctuation that follows it ("." "," ";" ":" "!" "?" ")"), kept on its line and with no space before it. */
export type GluedPart = LibraryAskPart | (Extract<LibraryAskPart, { kind: "cite" }> & { trailing: string });

/** Moves the punctuation right after a citation (dropping any space before it) onto the citation, so it never starts a line or floats. */
export function glueCitationPunctuation(parts: LibraryAskPart[]): GluedPart[] {
  const out: GluedPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (part.kind === "cite" && next?.kind === "text") {
      const m = /^\s*([.,;:!?)]+)/.exec(next.value);
      if (m) {
        out.push({ ...part, trailing: m[1]! });
        const rest = next.value.slice(m[0].length);
        if (rest) out.push({ kind: "text", value: rest });
        i++;
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

/** The reasons in the order the line names them. */
const NOT_SEARCHED_ORDER: LibraryNotSearchedReason[] = ["awaiting_context", "removed", "processing", "unavailable"];

/**
 * The line under an answer naming the owner's videos it couldn't search, counted by reason ("Not searched: 2 videos
 * still waiting for your context answers, 1 still processing."), and each video with its reason, grouped in that
 * order. Null when every video was searched, or for an answer stored before this was recorded.
 */
export function notSearchedSummary(ns: LibraryNotSearched | null): { line: string; items: { sessionId: string; title: string; reason: string }[] } | null {
  if (!ns || ns.videos.length === 0) return null;
  const days = ns.retentionDays;
  const groups = NOT_SEARCHED_ORDER.map((reason) => ({ reason, videos: ns.videos.filter((v) => v.reason === reason) })).filter((g) => g.videos.length > 0);
  const parts = groups.map((g, i) => {
    const n = g.videos.length;
    const count = i > 0 ? String(n) : n === 1 ? t("libraryAsk.notSearched.firstOne") : t("libraryAsk.notSearched.firstMany", { n });
    return t(`libraryAsk.notSearched.count.${g.reason}`, { count, days });
  });
  const items = groups.flatMap((g) => g.videos.map((v) => ({ sessionId: v.sessionId, title: v.title, reason: t(`libraryAsk.notSearched.reason.${g.reason}`, { days }) })));
  return { line: t("libraryAsk.notSearched.line", { parts: parts.join(", ") }), items };
}
