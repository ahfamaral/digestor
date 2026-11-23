/** Above this many shown moments a Briefing starts with its topics closed (title, summary, counts), so it isn't one long scroll. */
export const LONG_BRIEFING = 40;

/** Whether a topic card shows its moments: the reader's choice for that topic, else open unless the Briefing is long. */
export function topicOpen(key: string, choices: Readonly<Record<string, boolean>>, shown: number): boolean {
  return choices[key] ?? shown <= LONG_BRIEFING;
}

/** The same choice for every topic (Open all / Close all). */
export function allTopics(keys: readonly string[], open: boolean): Record<string, boolean> {
  return Object.fromEntries(keys.map((k) => [k, open]));
}
