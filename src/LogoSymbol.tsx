import { SYMBOL_ASPECT, SYMBOL_PATHS, SYMBOL_VIEW_BOX } from "./symbolGeometry";

interface LogoSymbolProps {
  /** Height in px. Width follows from the artwork's own aspect ratio. */
  height?: number;
  className?: string;
  /**
   * An accessible name, when the symbol is the only thing naming the brand.
   * Left off by default: the marketing header pairs it with a labelled wordmark
   * and marks the symbol decorative, and the app's splash does the same, so a
   * second "SnapGut" here would just be read out twice.
   */
  label?: string;
}

/**
 * The SnapGut brand symbol — the same mark the marketing header shows, drawn
 * from `brand/logo-symbol-white.svg` via `src/symbolGeometry.ts`.
 *
 * Painted with `currentColor` rather than the artwork's two-tone fills, so it
 * follows the surface it sits on: on the accent-gradient badge that is the
 * white-on-green treatment the favicon and the install icons use.
 *
 * Width and height are attributes rather than CSS, so the box is reserved before
 * any stylesheet lands and the splash cannot reflow.
 */
export default function LogoSymbol({ height = 54, className, label }: LogoSymbolProps) {
  const width = Math.round(height * SYMBOL_ASPECT * 100) / 100;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={SYMBOL_VIEW_BOX}
      fill="currentColor"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {SYMBOL_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
