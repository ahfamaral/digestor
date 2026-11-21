import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadForm } from "./UploadForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());

describe("UploadForm goal", () => {
  it("shows the goal field above the optional details, with three chips", () => {
    const html = renderToStaticMarkup(<UploadForm />);
    expect(html.indexOf("What do you want from this video?")).toBeGreaterThan(-1);
    expect(html.indexOf("What do you want from this video?")).toBeLessThan(html.indexOf("Anything we should know?"));
    expect(buttons(html)).toEqual(expect.arrayContaining(["3 clips for Instagram", "The heated exchanges", "Everything one speaker says about a topic"]));
  });
});
