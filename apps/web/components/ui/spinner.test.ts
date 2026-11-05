import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Busy, Spinner } from "./spinner";

describe("Spinner and Busy", () => {
  it("renders a hidden icon that only spins when motion is allowed", () => {
    const html = renderToStaticMarkup(createElement(Spinner));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain("size-3.5");
  });
  it("puts the spinner before the text while busy, and keeps the text", () => {
    const html = renderToStaticMarkup(createElement(Busy, { busy: true, children: "Saving…" }));
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("Saving…"));
  });
  it("renders only the text when not busy", () => {
    const html = renderToStaticMarkup(createElement(Busy, { busy: false, children: "Save" }));
    expect(html).toBe("Save");
  });
});
