// Derives every shipped icon from the brand sources in `brand/`.
//
//   brand/favicon.svg  -> browser tab icons AND the green Android/PWA icon set
//   brand/favicon.png  -> raster reference for the same mark (not shipped directly)
//   brand/app-icon.png -> the light iOS home-screen icon
//
// The mark sits on a full-bleed basil-green tile in every output. That tile is
// deliberate: a bare glyph disappears against a browser's tab strip, so the
// green gives the icon an edge and a silhouette at 16px.
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

/**
 * Maskable variant: the tile shrunk into the centre 80% so Android's
 * circle/squircle/teardrop masks can crop 10% off every edge without
 * clipping the mark. The margin is the same green, so the seam is invisible.
 */
async function writeMaskable(src, size, name, background) {
  const inner = Math.round(size * 0.8);
  const pad = Math.round((size - inner) / 2);
  const art = await load(src).resize(inner, inner, { fit: "cover", kernel: "lanczos3" }).toBuffer();
  const buf = await sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: art, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(new URL(name, OUT), buf);
  console.log(`wrote public/${name} (${size}x${size}, maskable, bg ${hex(background)})`);
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
const light = await edgeColor(appIcon);

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
// iOS keeps the light app icon; the manifest set Android reads is the green
// variation, so the launcher icon and its splash sit on the brand green
// instead of a light tile.
await write(appIcon, 180, "apple-touch-icon.png", light);
await write(mark, 192, "icon-192.png", green);
await write(mark, 512, "icon-512.png", green);
await writeMaskable(mark, 512, "icon-maskable-512.png", green);

console.log(`\nbrand green ${hex(green)} · app-icon edge ${hex(light)}`);
