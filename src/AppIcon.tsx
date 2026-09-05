interface AppIconProps {
  /** Rendered size in CSS px, square. */
  size?: number;
  className?: string;
  /**
   * An accessible name, when the icon is the only thing naming the product.
   * Left off by default: the splash pairs it with the labelled wordmark and the
   * sign-in screen with a heading that names SnapGut, so a name here would just
   * be read out twice.
   */
  label?: string;
}

/**
 * The installed app's icon — the same artwork the home screen and the manifest
 * carry (`brand/app-icon.png`, via `npm run icons`), not a re-drawing of it.
 *
 * A raster rather than the inline symbol geometry `LogoSymbol` uses: the tile's
 * gradient and the mark's proportions are baked into the delivered artwork, and
 * re-deriving them in CSS is how the icon on screen drifts from the icon on the
 * home screen. The cost is one 10 KB request, which the badge underneath hides —
 * `.intro-badge` paints the tile's gradient itself, so the box is the right
 * colour and the right shape before this lands and nothing moves when it does.
 *
 * Width and height are attributes as well as CSS so the box is reserved before
 * any stylesheet arrives.
 */
export default function AppIcon({ size = 108, className, label }: AppIconProps) {
  return (
    <img
      className={className ? `app-icon ${className}` : "app-icon"}
      src="/app-icon-384.webp"
      width={size}
      height={size}
      decoding="async"
      // Decorative by default, so `alt=""` keeps it out of the accessibility
      // tree entirely rather than announcing a filename.
      alt={label ?? ""}
      {...(label ? {} : { "aria-hidden": true })}
    />
  );
}
