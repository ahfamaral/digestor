/** WCAG contrast. The colour tokens below are the single source for the AA test; `app/globals.css` repeats the same hex values (the test checks that it does). */
export const COLOR_TOKENS = {
  background: "#f6f5f2",
  white: "#ffffff",
  mutedForeground: "#6b6c74",
  brand: "#c2410c",
  brandForeground: "#ffffff",
  stepUpcoming: "#6b6a64",
  stepDone: "#047857",
  disabledBg: "#e7e5e4",
  disabledFg: "#5f5e58",
  /** Focus ring (`--ring`): a non-text indicator, at least 3:1 on white and on the page (WCAG 1.4.11, 2.4.13). */
  ring: "#57534e",
} as const;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio (1 to 21) between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
