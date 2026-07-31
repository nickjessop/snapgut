// Builds the Open Graph card the Marketing_Pages point `og:image` at
// (Requirement 8.4), from the same brand source the app icons come from.
//
//   brand/app-icon.png -> public/og.png  (1200x630)
//
// Run with `npm run og` after the brand mark or the tagline changes. The output
// lands in `public/`, which Vite copies verbatim into the Build_Output, so the
// card is a same-origin asset at the fixed path `/og.png`. Fixed rather than
// content-hashed on purpose: crawlers read the URL as a literal string out of
// `marketing/partials/meta.html`, so there is nowhere for a hash to come from —
// the same reason the icons and the manifest keep fixed names.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const W = 1200;
const H = 630;

const ICON = fileURLToPath(new URL("../brand/app-icon.png", import.meta.url));
const OUT = new URL("../public/og.png", import.meta.url);

// The site palette, from marketing/marketing.css.
const INK = "#14261f";
const GREEN_900 = "#23453a";
const GREEN_800 = "#2d5d4d";
const MINT = "#b9e4c9";
const CREAM = "#fdfcf6";
const CLAY = "#cd8560";

const FONT_DISPLAY = "Iowan Old Style, Palatino, Georgia, Times New Roman, serif";
const FONT_BODY = "Helvetica Neue, Helvetica, Arial, sans-serif";

const MARK = 168; // brand mark edge length
const PAD = 84; // outer padding

/** Rounded-corner mask for the brand mark, applied with `dest-in`. */
const roundedMask = (size, radius) =>
  Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
       <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>
     </svg>`
  );

/**
 * Everything except the brand mark: the background wash, the accent rule, the
 * wordmark, the tagline, and the host line. One SVG so the type sits on exact
 * baselines rather than on composited guesses.
 */
const plate = () =>
  Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0%" stop-color="${GREEN_800}"/>
           <stop offset="55%" stop-color="${GREEN_900}"/>
           <stop offset="100%" stop-color="${INK}"/>
         </linearGradient>
       </defs>

       <rect width="${W}" height="${H}" fill="url(#bg)"/>

       <!-- Two soft basil arcs, bottom-right, well under the type. -->
       <g fill="none" stroke="${MINT}" stroke-opacity="0.16" stroke-width="2">
         <circle cx="${W - 90}" cy="${H - 60}" r="210"/>
         <circle cx="${W - 90}" cy="${H - 60}" r="310"/>
       </g>

       <!-- Terracotta rule, the one warm note. -->
       <rect x="${PAD}" y="${H - 118}" width="132" height="6" rx="3" fill="${CLAY}"/>

       <text x="${PAD + MARK + 34}" y="${PAD + 118}"
             font-family="${FONT_DISPLAY}" font-size="104" font-weight="bold"
             letter-spacing="-2" fill="${CREAM}">SnapGut</text>

       <text x="${PAD}" y="${PAD + 268}"
             font-family="${FONT_DISPLAY}" font-size="58" font-weight="bold"
             letter-spacing="-1" fill="${CREAM}">Know what your gut is telling you</text>

       <text x="${PAD}" y="${PAD + 340}"
             font-family="${FONT_BODY}" font-size="32" fill="${MINT}"
             >Snap a meal, log how you feel, see what tracks with your symptoms.</text>

       <text x="${PAD}" y="${H - 58}"
             font-family="${FONT_BODY}" font-size="28" font-weight="bold"
             letter-spacing="1" fill="${CLAY}">snapgut.com</text>
     </svg>`
  );

const mark = await sharp(ICON)
  .resize(MARK, MARK, { fit: "cover" })
  .composite([{ input: roundedMask(MARK, 40), blend: "dest-in" }])
  .png()
  .toBuffer();

const png = await sharp(plate())
  .composite([{ input: mark, top: PAD, left: PAD }])
  .png({ compressionLevel: 9 })
  .toBuffer();

writeFileSync(OUT, png);

const { width, height } = await sharp(png).metadata();
console.log(`wrote public/og.png (${width}x${height}, ${(png.length / 1024).toFixed(1)} KB)`);
