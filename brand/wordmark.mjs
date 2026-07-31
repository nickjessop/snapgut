/**
 * The SnapGut wordmark, drawn rather than typeset.
 *
 * Every surface that shows the name — the app splash, the marketing header, the
 * Open Graph card — used to set it in `Iowan Old Style` with a serif fallback
 * stack. That is fine in a browser and quietly wrong in a build: `gen-og.mjs`
 * rasterizes its SVG through sharp, so the card's wordmark rendered in whatever
 * the *build machine* had installed. On a Mac that is Iowan; in a Linux
 * container it is a default serif. Geometry has no such dependency, so the mark
 * below is a set of paths and renders identically everywhere.
 *
 * ── The letterforms ────────────────────────────────────────────────────────
 * A geometric monoline: one constant stroke weight, bowls that are true
 * circles, round terminals. It reads as a sibling of the app icon's soft mark
 * rather than of the editorial serif the body copy uses.
 *
 * Signature details, so this is a specific face and not a default one:
 *   · single-storey `a` — a closed circle plus a tangent stem, Futura's move,
 *     which sets it apart from the double-storey `a` most app wordmarks use
 *   · `G` whose bar meets the bowl at 3 o'clock, leaving the aperture open at
 *     the lower right instead of closing it with a spur
 *   · `S` with terminals cut at 35°, so the apertures stay wide at small sizes
 *   · `t` with a full quarter-circle foot, echoing the bowls
 *   · round caps and joins throughout, and a 1.5-unit overshoot on round
 *     extremes so `S G a p u` sit optically level with the flat-footed `n t`
 *
 * ── Why strokes and not filled outlines ────────────────────────────────────
 * The glyphs are skeletons carrying `stroke-width`, not filled contours. That
 * keeps the design one number away from a different weight (`WEIGHT` below),
 * keeps every curve a verifiable arc rather than a pile of bezier handles, and
 * holds up better than a heavy filled face at the 28px the marketing header
 * asks for. The cost is that terminals must be round — a flat-cut grotesque
 * would need the strokes converted to outlines, which needs a boolean-geometry
 * dependency this repo deliberately does not carry.
 *
 * ── Coordinate system ──────────────────────────────────────────────────────
 * Units are 1/100th of the cap height. y runs down, the baseline sits at
 * y = 100, the cap line at y = 0. Because a stroke straddles its skeleton,
 * every skeleton coordinate is inset from the ink edge it produces by half the
 * weight — that inset is what `capTop`, `base`, `xTop` and friends encode, so
 * the numbers in the glyphs are skeleton positions and the metrics they derive
 * from are ink positions.
 *
 * This module is the single source of truth for the letterforms.
 * `scripts/gen-brand.mjs` derives `brand/wordmark.svg`, the marketing partial,
 * and `src/wordmarkGeometry.ts` from it; `brand/lockup.mjs` composes it with the
 * symbol, and `scripts/gen-og.mjs` draws that lockup onto the card. Nothing
 * hand-copies path data.
 */

// ---- Metrics ---------------------------------------------------------------

/** Stroke weight. The one dial that changes the wordmark's weight. */
const WEIGHT = 20;
/** Half the weight: the inset from any ink edge to the skeleton that makes it. */
const H = WEIGHT / 2;

const CAP = 100; // cap height, and the unit the whole system is scaled to
const XH = 72; // x-height
const DESC = 26; // how far `p` drops below the baseline
const OS = 1.5; // overshoot on round extremes

/** Round caps are narrowed against a true circle so `G` does not dwarf `a`. */
const CAP_WIDTH = 0.84;

// Skeleton lines, named for the ink edge each one produces.
const capTop = H; //            ink cap line, y = 0
const base = CAP - H; //        ink baseline, y = 100
const xTop = CAP - XH + H; //   ink x-height line, y = 28
const descBot = CAP + DESC - H; // ink descender, y = 126
const capTopO = capTop - OS; // round cap line, ink y = -1.5
const baseO = base + OS; //     round baseline, ink y = 101.5
const xTopO = xTop - OS; //     round x-height line, ink y = 26.5

/** Lowercase bowl: a true circle spanning the x-height plus its overshoot. */
const LC_R = (XH + 2 * OS - WEIGHT) / 2;
const LC_CY = CAP - XH / 2;

/** Cap bowl: cap height plus overshoot tall, narrowed by `CAP_WIDTH`. */
const CAP_RY = (CAP + 2 * OS - WEIGHT) / 2;
const CAP_RX = CAP_RY * CAP_WIDTH;
const CAP_CY = CAP / 2;

// ---- Path helpers ----------------------------------------------------------

const rad = (deg) => (deg * Math.PI) / 180;

/** Trim float noise; keeps the emitted `d` attributes readable. */
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * A point on an ellipse. Angles are degrees with y running down, so 0° is
 * 3 o'clock, 90° is 6 o'clock, and 270° (or -90°) is 12 o'clock.
 */
const pt = (cx, cy, rx, ry, deg) => [
  cx + rx * Math.cos(rad(deg)),
  cy + ry * Math.sin(rad(deg)),
];

/**
 * Elliptical arc commands from `a0` to `a1`, walking in the direction the sign
 * of `a1 - a0` implies. Split into steps of at most 90° so `large-arc-flag` is
 * always 0 and the sweep can never be the ambiguous one — the reason the glyphs
 * below can be written as angles instead of as endpoint coordinates.
 */
function arc(cx, cy, rx, ry, a0, a1) {
  const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
  const step = (a1 - a0) / steps;
  // Increasing angle runs from +x toward +y, which with y down is clockwise on
  // screen — exactly what SVG's sweep-flag 1 means.
  const sweep = step > 0 ? 1 : 0;
  let d = "";
  for (let i = 1; i <= steps; i++) {
    const [x, y] = pt(cx, cy, rx, ry, a0 + step * i);
    d += `A${n(rx)} ${n(ry)} 0 0 ${sweep} ${n(x)} ${n(y)}`;
  }
  return d;
}

const moveTo = (x, y) => `M${n(x)} ${n(y)}`;
const lineTo = (x, y) => `L${n(x)} ${n(y)}`;

/** A closed ellipse, opened at 9 o'clock where the tangent is vertical. */
const ring = (cx, cy, rx, ry) =>
  moveTo(...pt(cx, cy, rx, ry, 180)) + arc(cx, cy, rx, ry, 180, 540) + "Z";

// ---- Glyphs ----------------------------------------------------------------
//
// Each builder takes the x of its ink's left edge and returns the ink box it
// occupies plus its subpaths. `width` is ink width, so the letters are spaced
// edge to edge and the gaps in `KERN` are literal optical gaps.

/** `S` — two arcs meeting at a horizontal waist, terminals cut at 35°. */
function glyphS(dx) {
  const ry = (baseO - capTopO) / 4;
  const rx = ry * 0.9; // a touch narrower than the caps' round width
  const cx = dx + H + rx;
  // The circles are tangent at the waist, which puts a horizontal tangent on
  // both sides of the join — the spine reads as one continuous curve.
  const upper = capTopO + ry;
  const lower = baseO - ry;
  return {
    width: 2 * rx + WEIGHT,
    top: capTopO - H,
    bottom: baseO + H,
    paths: [
      moveTo(...pt(cx, upper, rx, ry, -35)) +
        arc(cx, upper, rx, ry, -35, -270) + // over the top and down the left
        arc(cx, lower, rx, ry, -90, 145), // out to the right and round the foot
    ],
  };
}

/** `n` — stem plus a semicircular arch. */
function glyphN(dx) {
  const r = 21.5;
  const left = dx + H;
  const right = left + 2 * r;
  const cy = xTopO + r;
  return {
    width: 2 * r + WEIGHT,
    top: xTopO - H,
    bottom: base + H,
    paths: [
      moveTo(left, base) +
        lineTo(left, cy) +
        arc(left + r, cy, r, r, 180, 360) +
        lineTo(right, base),
    ],
  };
}

/** `a` — single-storey: a closed circle with a stem on its right tangent. */
function glyphA(dx) {
  const cx = dx + H + LC_R;
  const stem = cx + LC_R;
  return {
    width: 2 * LC_R + WEIGHT,
    top: LC_CY - LC_R - H,
    bottom: LC_CY + LC_R + H,
    paths: [ring(cx, LC_CY, LC_R, LC_R), moveTo(stem, xTop) + lineTo(stem, base)],
  };
}

/** `p` — the same circle, stem on the left, carried down to the descender. */
function glyphP(dx) {
  const stem = dx + H;
  const cx = stem + LC_R;
  return {
    width: 2 * LC_R + WEIGHT,
    top: LC_CY - LC_R - H,
    bottom: descBot + H,
    paths: [ring(cx, LC_CY, LC_R, LC_R), moveTo(stem, xTop) + lineTo(stem, descBot)],
  };
}

/**
 * `G` — bowl open at the *upper* right, with the bar meeting it at 3 o'clock.
 *
 * The aperture has to sit above the bar, not below it: the stroke reads as a
 * `C` whose lower right carries on into the bar, so the gap is between the bar
 * and the terminal at 1 o'clock. Sweeping the other way round from the same
 * start point mirrors the letter vertically and produces a `G` that is subtly
 * upside down — which is exactly the bug this replaced.
 *
 * Most geometric G's hang the bar off a spur that narrows the aperture; letting
 * the bar land on the bowl's own extreme keeps the opening wide instead.
 */
function glyphG(dx) {
  const cx = dx + H + CAP_RX;
  const barEnd = cx + CAP_RX; // 3 o'clock: where bar and bowl meet
  const barStart = cx + 8; // stops just right of centre
  return {
    width: 2 * CAP_RX + WEIGHT,
    top: CAP_CY - CAP_RY - H,
    bottom: CAP_CY + CAP_RY + H,
    paths: [
      moveTo(barStart, CAP_CY) +
        lineTo(barEnd, CAP_CY) +
        // Down from the bar, along the foot, up the left and over the top,
        // stopping at 1 o'clock and leaving the upper right open.
        arc(cx, CAP_CY, CAP_RX, CAP_RY, 0, 300),
    ],
  };
}

/** `u` — `n` inverted: two stems over a semicircular trough. */
function glyphU(dx) {
  const r = 21.5;
  const left = dx + H;
  const right = left + 2 * r;
  const cy = baseO - r;
  return {
    width: 2 * r + WEIGHT,
    top: xTop - H,
    bottom: baseO + H,
    paths: [
      moveTo(left, xTop) +
        lineTo(left, cy) +
        arc(left + r, cy, r, r, 180, 0) +
        lineTo(right, xTop),
    ],
  };
}

/** `t` — short ascender, quarter-circle foot, bar on the x-height line. */
function glyphT(dx) {
  const r = 16;
  const stem = dx + 25; // the bar overhangs left, so the stem is inset
  const top = 22; // ink top at y = 12: above the x-height, below the cap
  const footCx = stem + r;
  return {
    width: 51,
    top: top - H,
    bottom: base + H,
    paths: [
      moveTo(stem, top) + lineTo(stem, base - r) + arc(footCx, base - r, r, r, 180, 90),
      moveTo(dx + H, xTop) + lineTo(footCx, xTop),
    ],
  };
}

// ---- Composition -----------------------------------------------------------

const GLYPHS = { S: glyphS, n: glyphN, a: glyphA, p: glyphP, G: glyphG, u: glyphU, t: glyphT };

const WORD = "SnapGut";

/**
 * Optical gaps between adjacent ink boxes. Round-to-round wants least air,
 * stem-to-stem wants most — spacing the boxes evenly would read as loose at
 * `pG` and cramped at `ap`.
 */
const KERN = { Sn: 5, na: 6, ap: 9, pG: 3, Gu: 4, ut: 6 };

/**
 * The laid-out wordmark: subpaths in a single coordinate system, plus the box
 * that contains their ink and the stroke weight they must be drawn with.
 */
export function wordmarkGeometry() {
  const paths = [];
  let x = 0;
  let top = Infinity;
  let bottom = -Infinity;

  for (let i = 0; i < WORD.length; i++) {
    const glyph = GLYPHS[WORD[i]](x);
    paths.push(...glyph.paths);
    top = Math.min(top, glyph.top);
    bottom = Math.max(bottom, glyph.bottom);
    x += glyph.width;
    if (i < WORD.length - 1) x += KERN[WORD[i] + WORD[i + 1]];
  }

  const width = Math.round(x * 100) / 100;

  // The box a layout gets is padded to sit symmetrically about the cap band,
  // rather than being the tight ink box.
  //
  // The ink is lopsided: 1.5 units of overshoot above the cap line, 26 units of
  // `p` descender below the baseline. Centring the tight box in a flex row —
  // which is exactly what the marketing header and the app splash do — would
  // therefore centre the descender too and leave the letters riding ~2px high
  // next to the app icon. Balancing the box here means `align-items: center`
  // is simply correct at any size, in both stylesheets, with no magic offset.
  const half = Math.max(-top, bottom - CAP);
  const boxTop = -half;
  const boxHeight = CAP + 2 * half;

  return {
    paths,
    strokeWidth: WEIGHT,
    width,
    /** The tight ink box, for anything that needs true bounds. */
    inkMinY: top,
    inkHeight: Math.round((bottom - top) * 100) / 100,
    /** The balanced layout box: vertically centred on the cap band. */
    minY: boxTop,
    height: boxHeight,
    viewBox: `0 ${n(boxTop)} ${n(width)} ${n(boxHeight)}`,
    /** Layout box width / height, for sizing without a second measurement. */
    aspect: Math.round((width / boxHeight) * 10000) / 10000,
    /** Cap height as a fraction of the layout box, for optical sizing. */
    capRatio: Math.round((CAP / boxHeight) * 10000) / 10000,
    /** The cap height itself, in the coordinate system above. */
    cap: CAP,
  };
}

/** The shared presentation attributes. Round everything; inherit the colour. */
const strokeAttrs = (geo, ink) =>
  `fill="none" stroke="${ink}" stroke-width="${geo.strokeWidth}" ` +
  `stroke-linecap="round" stroke-linejoin="round"`;

/**
 * The wordmark as a `<g>`, for dropping into a larger SVG.
 *
 * Placed the way type is placed — by cap height and baseline, not by bounding
 * box — so it can be set against other type and optically aligned without
 * anyone having to reason about the descender or the overshoot.
 */
export function wordmarkGroup({ x = 0, baseline = 0, capHeight = 100, ink = "currentColor" } = {}) {
  const geo = wordmarkGeometry();
  const s = capHeight / CAP;
  return (
    // Maps user-space y = CAP onto `baseline`, and user-space x = 0 onto `x`.
    `<g transform="translate(${n(x)} ${n(baseline - CAP * s)}) scale(${n(s)})" ` +
    `${strokeAttrs(geo, ink)}>` +
    geo.paths.map((d) => `<path d="${d}"/>`).join("") +
    `</g>`
  );
}



/** The wordmark as a standalone `<svg>` document. */
export function wordmarkSvg({
  ink = "currentColor",
  className = "",
  ariaLabel = WORD,
  attrs = "",
  indent = "",
} = {}) {
  const geo = wordmarkGeometry();
  const cls = className ? ` class="${className}"` : "";
  const extra = attrs ? ` ${attrs}` : "";
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${geo.viewBox}"${cls}${extra} ` +
    `role="img" aria-label="${ariaLabel}" ${strokeAttrs(geo, ink)}>`;
  const body = geo.paths.map((d) => `${indent}  <path d="${d}" />`).join("\n");
  return `${open}\n${body}\n${indent}</svg>`;
}

export const WORDMARK_TEXT = WORD;
