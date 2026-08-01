// Derives every shipped icon from the brand sources in `brand/`.
//
//   brand/favicon.svg  -> browser tab icons (favicon.svg/.ico/-32/-96)
//   brand/favicon.png  -> raster reference for the same mark (not shipped directly)
//   brand/app-icon.png -> every *app* icon: the home-screen set, the PWA manifest
//                         set, and the badge the app's own splash and sign-in
//                         screen show (public/app-icon-384.png)
//
// The two sources are deliberately different treatments of the same mark. The
// favicon sits on a full-bleed flat basil tile, because a bare glyph disappears
// against a browser's tab strip and the green is what gives it a silhouette at
// 16px. The app icon is the designed tile — the accent gradient, corner to
// corner — and it is the one thing a user installs, so it is used verbatim
// everywhere the product shows "the app icon" rather than being re-derived.
//
// Run with `npm run icons` after any source changes. Everything lands in
// `public/`, which Vite copies verbatim into the build.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SRC = new URL("../brand/", import.meta.url);
const OUT = new URL("../public/", import.meta.url);

const mark = fileURLToPath(new URL("favicon.svg", SRC));
const appIcon = fileURLToPath(new URL("app-icon.png", SRC));

// Render the SVG far above any output size, then downscale. Rasterizing
// straight to 16px loses the stroke weights; downsampling a large render
// keeps them.
const RENDER_DPI = 600;

const load = (src) => (src === mark ? sharp(src, { density: RENDER_DPI }) : sharp(src));

/** Average of the outermost ring of pixels — the source's own edge colour. */
async function edgeColor(src) {
  const { data, info } = await load(src)
    .resize(64, 64, { fit: "cover" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x, y) => {
    const i = (y * w + x) * ch;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), alpha: 1 };
}

const hex = ({ r, g, b }) =>
  "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/**
 * The exact fill of the SVG's backdrop rect. Sampling the rendered edge
 * instead would average in the mark's antialiasing — close, but a shade off,
 * which shows up as a seam where the maskable icon's padding meets the tile.
 */
function svgBackdrop(src) {
  const svg = readFileSync(src, "utf8");
  const m = svg.match(/<rect\b[^>]*\bfill="#([0-9a-fA-F]{6})"/);
  if (!m) throw new Error(`no backdrop rect fill found in ${src}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

/** Square render, flattened onto `background` so no alpha survives. */
function render(src, size, background) {
  return load(src)
    .resize(size, size, { fit: "cover", kernel: "lanczos3" })
    .flatten({ background })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function write(src, size, name, background) {
  const buf = await render(src, size, background);
  writeFileSync(new URL(name, OUT), buf);
  console.log(`wrote public/${name} (${size}x${size}, bg ${hex(background)})`);
}

/** As `write`, in WebP — for the copy the app itself fetches rather than installs. */
async function writeWebp(src, size, name, background) {
  const buf = await load(src)
    .resize(size, size, { fit: "cover", kernel: "lanczos3" })
    .flatten({ background })
    .webp({ quality: 92 })
    .toBuffer();
  writeFileSync(new URL(name, OUT), buf);
  const kb = (buf.length / 1024).toFixed(1);
  console.log(`wrote public/${name} (${size}x${size}, webp, ${kb} KB)`);
}

/**
 * The top-left and bottom-right colours of a tile, read from small patches at
 * the very corners rather than from an average of the whole edge. The app icon's
 * artwork is inset from the edge, so those patches are pure tile — which is what
 * makes them usable as the stops of a matching gradient.
 */
async function tileCorners(src) {
  const { width, height } = await load(src).metadata();
  const patch = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  const at = async (left, top) => {
    const { data, info } = await load(src)
      .extract({ left, top, width: patch, height: patch })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), alpha: 1 };
  };
  return {
    from: await at(0, 0),
    to: await at(width - patch, height - patch),
  };
}

/** A 135° two-stop gradient square — the tile's own ramp, rebuilt at any size. */
function gradientTile(size, from, to) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hex(from)}"/><stop offset="1" stop-color="${hex(to)}"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" fill="url(#g)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Maskable variant: the tile shrunk into the centre 80% so Android's
 * circle/squircle/teardrop masks can crop 10% off every edge without clipping
 * the mark.
 *
 * The 10% margin is a *rebuilt* gradient rather than a flat fill or a
 * full-bleed copy of the source underneath. A flat fill would band against a
 * gradient tile, and a full-bleed copy would leave a sliver of the mark's own
 * edge showing in the margin, since the artwork reaches to about 8% of the
 * source. Continuing the ramp instead leaves only the ~10%-of-range step at the
 * inset boundary, which is a couple of values per channel.
 */
async function writeMaskable(src, size, name) {
  const inner = Math.round(size * 0.8);
  const pad = Math.round((size - inner) / 2);
  const { from, to } = await tileCorners(src);
  const art = await load(src).resize(inner, inner, { fit: "cover", kernel: "lanczos3" }).toBuffer();
  const buf = await sharp(await gradientTile(size, from, to))
    .composite([{ input: art, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(new URL(name, OUT), buf);
  console.log(
    `wrote public/${name} (${size}x${size}, maskable, margin ${hex(from)}->${hex(to)})`,
  );
}

/**
 * Multi-size .ico. Every entry is a full PNG payload, which the ICO format
 * has allowed since Vista and every current browser reads.
 */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

mkdirSync(OUT, { recursive: true });

const green = svgBackdrop(mark);
const tile = await edgeColor(appIcon);

// --- Browser tab icons (green tile) ---------------------------------------
// The SVG ships as-is and wins wherever it is supported; the raster sizes and
// the .ico cover Safari and anything older.
copyFileSync(mark, fileURLToPath(new URL("favicon.svg", OUT)));
console.log("wrote public/favicon.svg (source SVG)");
await write(mark, 32, "favicon-32.png", green);
await write(mark, 96, "favicon-96.png", green);

const icoSizes = [16, 32, 48];
const icoEntries = [];
for (const size of icoSizes) {
  icoEntries.push({ size, png: await render(mark, size, green) });
}
writeFileSync(new URL("favicon.ico", OUT), ico(icoEntries));
console.log(`wrote public/favicon.ico (${icoSizes.join(", ")}, bg ${hex(green)})`);

// --- Home screen / install icons ------------------------------------------
// One artwork across iOS, Android and the manifest, so the icon a user taps is
// the icon they were shown. `flatten` is a no-op on an opaque source and is left
// in only so a future source with alpha still lands on the tile rather than on
// black.
await write(appIcon, 180, "apple-touch-icon.png", tile);
await write(appIcon, 192, "icon-192.png", tile);
await write(appIcon, 512, "icon-512.png", tile);
await writeMaskable(appIcon, 512, "icon-maskable-512.png");

// --- In-app badge ----------------------------------------------------------
// The splash and the sign-in screen draw the same icon at 108-116 CSS px, so 384
// covers a 3x screen without shipping the 512 to do it. WebP rather than PNG:
// a full-bleed gradient is close to the worst case for PNG's filters, and this is
// the one copy of the icon that is fetched on a first run rather than installed
// once by the platform. The food pack is already WebP, so nothing new is assumed
// about the browser.
await writeWebp(appIcon, 384, "app-icon-384.webp", tile);

console.log(`\nfavicon tile ${hex(green)} · app icon tile ${hex(tile)}`);
