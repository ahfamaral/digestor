import { describe, expect, it } from "vitest";
import { previewCss } from "./subtitlePreview";

describe("previewCss", () => {
  it("draws yellow above the banner like the render", () => {
    const css = previewCss({ style: "yellow", position: "above_banner", format: "16:9" }, 540);
    expect(css).toMatchObject({ color: "#FFE600", fontWeight: 700, bottom: "22%" });
    expect(css.fontSize).toBeCloseTo(29.7, 5);
    expect(css.top).toBeUndefined();
  });
  it("scales the 4 px / 1 px border from 1080p", () => {
    const css = previewCss({ style: "white", position: "bottom", format: "16:9" }, 540);
    // outline 2 px outside at 540p = a 4 px centred stroke, fill painted over it
    expect(css.WebkitTextStroke).toBe("4px #000");
    expect(css.paintOrder).toBe("stroke fill");
    expect(css.textShadow).toBe("0px 1px 0px #000");
  });
  it("white_box has a 75% dark box and regular weight", () => {
    const css = previewCss({ style: "white_box", position: "bottom", format: "16:9" }, 1080);
    expect(css.backgroundColor).toBe("rgba(0,0,0,0.75)");
    expect(css.fontWeight).toBe(400);
    expect(css.bottom).toBe("6%");
  });
  it("top sets top and no bottom", () => {
    const css = previewCss({ style: "yellow", position: "top", format: "16:9" }, 540);
    expect(css.top).toBe("5%");
    expect(css.bottom).toBeUndefined();
  });
  it("9:16 uses a 4% font, 16:9 5.5%", () => {
    expect(previewCss({ style: "white", position: "bottom", format: "9:16" }, 400).fontSize).toBeCloseTo(16, 5);
    expect(previewCss({ style: "white", position: "bottom", format: "16:9" }, 400).fontSize).toBeCloseTo(22, 5);
  });
});
