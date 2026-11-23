import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppBar } from "./AppBar";

describe("AppBar", () => {
  it("marks Sessions as the current page on journalist pages, with a skip link to the main content", () => {
    const html = renderToStaticMarkup(<AppBar current="Briefing" />);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/">Sessions</);
    expect(html).toContain('href="#content"');
  });
  it("marks Monitor on the monitor and nothing on the login page", () => {
    expect(renderToStaticMarkup(<AppBar area="monitor" />)).toMatch(/aria-current="page"[^>]*>Monitor/);
    expect(renderToStaticMarkup(<AppBar signedOut />)).not.toContain('aria-current="page"');
  });
});
