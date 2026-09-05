/**
 * Reads the delivered symbol artwork so the rest of the brand code can place it.
 *
 * Three variants ship as hand-authored sources in this directory, identical in
 * geometry and differing only in fill:
 *
 *   logo-symbol.svg        the coloured mark — basil green with a terracotta accent
 *   logo-symbol-white.svg  a single white fill, for solid green or terracotta grounds
 *   logo-symbol-black.svg  a single black fill, for single-colour reproduction
 *
 * They are not generated and must not be rewritten by a script — this module
 * only ever reads them. The ink fills the 414x319 viewBox edge to edge with no
 * padding, which is what lets a plain box-centre also be an optical centre.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @typedef {"colour" | "white" | "black"} SymbolVariant */

const FILE = {
  colour: "logo-symbol.svg",
  white: "logo-symbol-white.svg",
  black: "logo-symbol-black.svg",
};

/** The flat fill each single-colour variant uses, for recolouring. */
const FLAT_FILL = { white: "white", black: "black" };

/**
 * The symbol's artwork: its intrinsic box and the markup inside its `<svg>`,
 * ready to drop into a `<g>`.
 *
 * `ink` recolours a single-colour variant — the card, for instance, wants the
 * white mark in the site's cream rather than in pure white, so the lockup is
 * one tone with the type beside it. Recolouring the coloured variant would mean
 * flattening two fills into one and is refused rather than guessed at.
 *
 * @param {{ variant?: SymbolVariant, ink?: string | null }} [options]
 */
export function loadSymbol({ variant = "colour", ink = null } = {}) {
  const file = FILE[variant];
  if (!file) throw new Error(`unknown symbol variant: ${variant}`);

  const svg = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  const box = svg.match(/\bviewBox="([\d.\s-]+)"/);
  if (!box) throw new Error(`no viewBox in brand/${file}`);
  const [minX, minY, width, height] = box[1].trim().split(/\s+/).map(Number);

  const open = svg.match(/<svg\b[^>]*>/);
  const close = svg.lastIndexOf("</svg>");
  if (!open || close < 0) throw new Error(`brand/${file} is not a single <svg> document`);
  let inner = svg.slice(open.index + open[0].length, close).trim();

  if (ink) {
    const flat = FLAT_FILL[variant];
    if (!flat) {
      throw new Error(
        `cannot recolour the ${variant} symbol: it uses more than one fill. ` +
          `Use variant "white" or "black" when an ink is given.`
      );
    }
    const before = inner;
    inner = inner.replaceAll(`fill="${flat}"`, `fill="${ink}"`);
    if (inner === before) throw new Error(`no fill="${flat}" found in brand/${file}`);
  }

  return { variant, file, minX, minY, width, height, aspect: width / height, inner };
}

/** The box a given height produces, at the artwork's own aspect ratio. */
export function symbolBox(height, variant = "colour") {
  const { aspect } = loadSymbol({ variant });
  return { width: Math.round(height * aspect * 100) / 100, height };
}
