import { splitHighlights } from "@digestor/core";

/** A search snippet: matched words in `<mark>`, everything as text (official text is never rendered as HTML). */
export function Highlighted({ text }: { text: string }) {
  return (
    <>
      {splitHighlights(text).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-stone-200 px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
