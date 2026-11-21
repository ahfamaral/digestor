import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClipIndex, type ClipIndexEntry } from "./ClipIndex";

const entry = (id: string, n: number, madeByAsk: boolean): ClipIndexEntry => ({ id, n, title: `T${n}`, startMs: n * 1000, status: { ready: true }, dismissed: false, madeByAsk });

describe("ClipIndex", () => {
  it("tags clips made with Ask", () => {
    const html = renderToStaticMarkup(<ClipIndex entries={[entry("a", 1, true), entry("b", 2, false)]} language="en" onJump={() => {}} />);
    expect(html.match(/Made with Ask/g)).toHaveLength(1);
    expect(html.indexOf("Made with Ask")).toBeLessThan(html.indexOf("T2"));
  });
});
