import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClipStrip, type ClipTile } from "./ClipStrip";

const tile = (o: Partial<ClipTile>): ClipTile => ({
  id: "c1", startMs: 0, endMs: 30_000, format: "16:9", merged: false, rendered: true, thumbUrl: null, languages: [], audio: false, ...o,
});
const html = (c: ClipTile) => renderToStaticMarkup(<ClipStrip sessionId="s1" clips={[c]} />);

describe("ClipStrip tiles", () => {
  it("show the thumbnail when there is one", () => {
    const out = html(tile({ thumbUrl: "/api/files/s1/thumbs/m1.jpg" }));
    expect(out).toContain('src="/api/files/s1/thumbs/m1.jpg"');
    expect(out).not.toContain("data-placeholder");
  });
  it("without a thumbnail show a waveform sign for an audio-only session and a film sign otherwise, never an empty box", () => {
    expect(html(tile({ audio: true }))).toContain('data-placeholder="audio"');
    expect(html(tile({ audio: false }))).toContain('data-placeholder="video"');
    expect(html(tile({ audio: true }))).not.toContain("<img");
  });
});
