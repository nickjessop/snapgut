import {
  WORDMARK_ASPECT,
  WORDMARK_CAP_RATIO,
  WORDMARK_PATHS,
  WORDMARK_STROKE,
  WORDMARK_VIEW_BOX,
} from "./wordmarkGeometry";

interface WordmarkProps {
  /**
   * Cap height in px — the height the letters *look*, which is what you want
   * when setting the mark against nearby type. The element itself is taller,
   * because the box also holds the `p` descender and the round overshoot.
   */
  cap?: number;
  className?: string;
}

/**
 * The SnapGut wordmark, drawn from `brand/wordmark.mjs` rather than typeset.
 *
 * Inherits colour through `currentColor` like the icon set does. Width and
 * height are set as attributes rather than left to CSS so the box is reserved
 * before any stylesheet lands and the splash cannot reflow.
 */
export default function Wordmark({ cap = 25, className }: WordmarkProps) {
  const height = Math.round((cap / WORDMARK_CAP_RATIO) * 100) / 100;
  const width = Math.round(height * WORDMARK_ASPECT * 100) / 100;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={WORDMARK_VIEW_BOX}
      role="img"
      aria-label="SnapGut"
      fill="none"
      stroke="currentColor"
      strokeWidth={WORDMARK_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {WORDMARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
