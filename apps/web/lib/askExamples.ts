import type { Topic, Word } from "@digestor/core";
import { focusOptions } from "./briefingData";
import { t } from "./i18n";
import type { NamesData } from "./names";

/** How many example questions the empty Ask drawer offers. */
const MAX_EXAMPLES = 3;
/** A topic title longer than this makes a clumsy question; such topics are left out. */
const MAX_TOPIC_CHARS = 60;

/** The examples for a session with no topics or names to build from. */
export const GENERIC_ASK_EXAMPLES: readonly string[] = [t("ask.example.mainTopics"), t("ask.example.longest"), t("ask.example.quotable")];

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Names the examples may use: the people Focus offers (named voices by speaking share), so the same rules as Ask's
 * naming apply: in a sensitive profile only confirmed names, and never a voice a human marked "No name".
 */
export function askExampleNames(names: NamesData, words: Word[], sensitive: boolean): string[] {
  const byId = new Map(names.persons.map((p) => [p.id, tidy(p.displayName)]));
  const out: string[] = [];
  for (const o of focusOptions(names, words, sensitive)) {
    const name = o.kind === "person" ? byId.get(o.personId) : undefined;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Topic titles for the examples: the longest topics first (the most discussed), short enough for a question. */
export function askExampleTopics(topics: Pick<Topic, "idx" | "title" | "startMs" | "endMs">[]): string[] {
  return [...topics]
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.idx - b.idx)
    .map((x) => tidy(x.title))
    .filter((title) => title.length > 0 && [...title].length <= MAX_TOPIC_CHARS);
}

/**
 * The empty Ask drawer's example questions (clicking one fills the input), built from this session's topics and
 * names; generic questions fill up the rest.
 */
export function askExamples({ topics, names }: { topics: string[]; names: string[] }): string[] {
  const [t1, t2] = topics;
  const [n1, n2] = names;
  const out: string[] = [];
  if (t1) out.push(n1 ? t("ask.example.saidAbout", { name: n1, topic: t1 }) : t("ask.example.topic", { topic: t1 }));
  if (t2) out.push(t("ask.example.quote", { topic: t2 }));
  const person = t1 ? n2 : n1;
  if (person) out.push(t("ask.example.person", { name: person }));
  for (const g of GENERIC_ASK_EXAMPLES) if (out.length < MAX_EXAMPLES && !out.includes(g)) out.push(g);
  return out.slice(0, MAX_EXAMPLES);
}
