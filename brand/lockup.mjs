/**
 * The horizontal lockup: the symbol beside the wordmark.
 *
 * One module owns the two numbers that decide how the pair sits together —
 * how tall the symbol is against the cap height, and how much air sits between
 * them — so the marketing header, the Open Graph card, and the reference
 * artwork cannot drift apart. Everything is expressed as a multiple of the
 * wordmark's cap height, so the lockup is scale-free: pick a cap height and
 * every other measurement follows.
 *
 * ── Vertical centring ──────────────────────────────────────────────────────
 * The symbol is centred on the wordmark's *cap band* — the block from cap line
 * to baseline — rather than on the wordmark's full box. Those are different
 * things: the box also holds the `p` descender, so centring on it would leave
 * the symbol sitting low. Two facts make this exact rather than approximate:
 *
 *   · the symbol's ink fills its 414x319 viewBox with no padding, so the
 *     symbol's box centre is its optical centre
 *   · `wordmarkGeometry()` reports a layout box already padded to sit
 *     symmetrically about the cap band, so in CSS a plain `align-items: center`
 *     lands on the same result this module computes for SVG
 */

import { loadSymbol } from "./symbol.mjs";
import { wordmarkGeometry, wordmarkGroup } from "./wordmark.mjs";

/** Symbol height as a multiple of cap height. */
export const SYMBOL_TO_CAP = 1.8;
/** Air between the symbol's right edge and the wordmark's left edge. */
export const GAP_TO_CAP = 0.6;

const round = (v) => Math.round(v * 100) / 100;

/**
 * Every measurement of the lockup at a given cap height: where each piece goes
 * and how big the whole thing is. `symbolY` and `wordmarkY` are offsets from
 * the top of the lockup box.
 */
export function lockupMetrics(capHeight = 100, variant = "colour") {
  const geo = wordmarkGeometry();
  const symbol = loadSymbol({ variant });

  const symbolHeight = capHeight * SYMBOL_TO_CAP;
  const symbolWidth = symbolHeight * symbol.aspect;
  const gap = capHeight * GAP_TO_CAP;

  const wordWidth = geo.width * (capHeight / geo.cap);
  const wordHeight = geo.height * (capHeight / geo.cap);
  // The wordmark's box is symmetric about its cap band, so the band's centre is
  // the box's centre — which is what both pieces get aligned to.
  const height = Math.max(symbolHeight, wordHeight);
  const centre = height / 2;

  return {
    capHeight,
    width: round(symbolWidth + gap + wordWidth),
    height: round(height),
    gap: round(gap),
    symbol: {
      x: 0,
      y: round(centre - symbolHeight / 2),
      width: round(symbolWidth),
      height: round(symbolHeight),
    },
    wordmark: {
      x: round(symbolWidth + gap),
      y: round(centre - wordHeight / 2),
      width: round(wordWidth),
      height: round(wordHeight),
      /** Baseline offset from the top of the lockup box. */
      baseline: round(centre - wordHeight / 2 + (geo.cap - geo.minY) * (capHeight / geo.cap)),
    },
  };
}

/**
 * The lockup as a `<g>`, for dropping into a larger SVG. `x`/`y` place its
 * top-left corner. `ink` recolours a single-colour symbol variant and the
 * wordmark together, which is how a light-on-dark lockup is made one tone.
 */
export function lockupGroup({
  x = 0,
  y = 0,
  capHeight = 100,
  variant = "colour",
  ink = "currentColor",
} = {}) {
  const m = lockupMetrics(capHeight, variant);
  const symbol = loadSymbol({ variant, ink: variant === "colour" ? null : ink });
  const s = m.symbol.width / symbol.width;

  return (
    `<g transform="translate(${round(x)} ${round(y)})">` +
    `<g transform="translate(${m.symbol.x} ${m.symbol.y}) scale(${round(s)})">${symbol.inner}</g>` +
    wordmarkGroup({
      x: m.wordmark.x,
      baseline: m.wordmark.baseline,
      capHeight,
      ink,
    }) +
    `</g>`
  );
}

/** The lockup as a standalone `<svg>` document. */
export function lockupSvg({
  capHeight = 100,
  variant = "colour",
  ink = "currentColor",
  className = "",
  ariaLabel = "SnapGut",
} = {}) {
  const m = lockupMetrics(capHeight, variant);
  const cls = className ? ` class="${className}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${m.height}"${cls} ` +
    `width="${m.width}" height="${m.height}" role="img" aria-label="${ariaLabel}">\n` +
    `  ${lockupGroup({ capHeight, variant, ink })}\n` +
    `</svg>`
  );
}
