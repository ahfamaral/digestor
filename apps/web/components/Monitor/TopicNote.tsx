/** A muted one-line note under a search. */
export function TopicNote({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}
