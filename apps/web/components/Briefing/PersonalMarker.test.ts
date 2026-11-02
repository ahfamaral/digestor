import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonalMarker } from "./PersonalMarker";

const html = (origin: Parameters<typeof PersonalMarker>[0]["origin"]) => renderToStaticMarkup(createElement(PersonalMarker, { origin }));

describe("PersonalMarker", () => {
  it("a found moment shows 'Found for you' with the AI badge, whatever its highlight chips", () => {
    const out = html("find_more");
    expect(out).toContain("Found for you");
    expect(out).toContain(">AI<");
  });
  it("Ask and user markers carry no AI badge; official moments no marker", () => {
    expect(html("ask")).toContain("Added by Ask");
    expect(html("ask")).not.toContain(">AI<");
    expect(html("user")).toContain("Added by you");
    expect(html("ai")).toBe("");
  });
});
