/**
 * Words one speaker (or party) uses more than everyone else: the weighted log-odds ratio with an informative Dirichlet
 * prior of Monroe, Colaresi & Quinn (2008), "Fightin' Words", §3.5.
 *
 * For each word w, with y the counts, n the corpus sizes and α_w = α0 · prior_w / Σ prior (the whole chamber's use of w,
 * scaled to α0 pseudo-words):
 *
 *   δ_w = ln((y_t + α_w) / (n_t + α0 − y_t − α_w)) − ln((y_r + α_w) / (n_r + α0 − y_r − α_w))
 *   σ²_w ≈ 1 / (y_t + α_w) + 1 / (y_r + α_w)
 *   z_w = δ_w / σ_w
 *
 * The prior pulls rare words toward the chamber's rate, so a word said once by the target and never by the rest does not
 * outrank one said twenty times. Positive z: the target uses the word more than the rest; z ≈ 0: about as much.
 * Pure arithmetic over counts, no model and no AI. The z is for ordering only: never shown.
 */
export function fightinWords(
  target: Map<string, number>,
  rest: Map<string, number>,
  prior: Map<string, number>,
  opts: { alpha0?: number } = {},
): { stem: string; z: number; nTarget: number }[] {
  const alpha0 = opts.alpha0 ?? DEFAULT_ALPHA0;
  const total = (x: Map<string, number>) => [...x.values()].reduce((a, b) => a + b, 0);
  const nT = total(target);
  const nR = total(rest);
  const stems = new Set([...target.keys(), ...rest.keys()]);
  if (stems.size === 0) return [];
  const priorTotal = total(prior);
  // A word missing from the prior (or an empty prior) still gets a small share, so its log never sees a zero.
  const floor = 1 / Math.max(stems.size, prior.size, 1);
  const out: { stem: string; z: number; nTarget: number }[] = [];
  for (const stem of stems) {
    const yT = target.get(stem) ?? 0;
    const yR = rest.get(stem) ?? 0;
    const share = priorTotal > 0 ? (prior.get(stem) ?? 0) / priorTotal : 0;
    const a = alpha0 * Math.max(share, floor / 100);
    const lT = Math.log((yT + a) / Math.max(nT + alpha0 - yT - a, 1e-9));
    const lR = Math.log((yR + a) / Math.max(nR + alpha0 - yR - a, 1e-9));
    const z = (lT - lR) / Math.sqrt(1 / (yT + a) + 1 / (yR + a));
    out.push({ stem, z, nTarget: yT });
  }
  return out.sort((x, y) => y.z - x.z || x.stem.localeCompare(y.stem));
}

/** Pseudo-words of prior: enough to calm one-off words in a deputy's few thousand words, small next to the chamber's. */
export const DEFAULT_ALPHA0 = 1000;
