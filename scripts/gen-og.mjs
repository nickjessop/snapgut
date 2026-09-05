// Builds the Open Graph card the Marketing_Pages point `og:image` at
// (Requirement 8.4), from the same brand sources every other mark comes from.
//
//   brand/lockup.mjs (symbol + wordmark) -> public/og.png  (1200x630)
//
// Run with `npm run og` after the brand marks or the tagline change. The output
// lands in `public/`, which Vite copies verbatim into the Build_Output, so the
// card is a same-origin asset at the fixed path `/og.png`. Fixed rather than
// content-hashed on purpose: crawlers read the URL as a literal string out of
// `marketing/partials/meta.html`, so there is nowhere for a hash to come from —
// the same reason the icons and the manifest keep fixed names.
//
// The card is one SVG rasterized once. It used to composite the app icon as a
// separate rounded-corner raster; the symbol is vector, so it now goes into the
// same plate as the type and needs no second pass.
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { lockupGroup, lockupMetrics } from "../brand/lockup.mjs";

const W = 1200;
const H = 630;

const OUT = new URL("../public/og.png", import.meta.url);

// The host printed on the card. Overridable so a fork can rebrand the card
// without editing the generator; the default is the original deployment.
const PUBLIC_HOST = process.env.PUBLIC_HOST || "snapgut.com";

// The site palette, from marketing/marketing.css.
const INK = "#14261f";
const GREEN_900 = "#23453a";
const GREEN_800 = "#2d5d4d";
const MINT = "#b9e4c9";
const CREAM = "#fdfcf6";
const CLAY = "#cd8560";

const FONT_DISPLAY = "Iowan Old Style, Palatino, Georgia, Times New Roman, serif";
const FONT_BODY = "Helvetica Neue, Helvetica, Arial, sans-serif";

const PAD = 84; // outer padding
const CAP = 72; // wordmark cap height; the lockup scales off this

// The ground is a dark green wash, so the lockup takes the white symbol variant.
// Both halves are inked in the site's cream rather than pure white so the mark
// is the same tone as the type beneath it — pass `ink: "#ffffff"` for a card
// that uses the white artwork verbatim.
const lockup = lockupMetrics(CAP, "white");

/**
 * The whole card: background wash, accent rule, the lockup, and the type. One
 * SVG so everything sits on exact coordinates rather than on composited
 * guesses.
 *
 * No `font-family` is used for the brand name: this SVG is rasterized by sharp,
 * so a font stack resolves against whatever the *build machine* has installed.
 * The wordmark is drawn geometry for exactly that reason (see
 * brand/wordmark.mjs). The three text runs below still carry that risk.
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

       ${lockupGroup({ x: PAD, y: PAD, capHeight: CAP, variant: "white", ink: CREAM })}

       <text x="${PAD}" y="${PAD + 268}"
             font-family="${FONT_DISPLAY}" font-size="58" font-weight="bold"
             letter-spacing="-1" fill="${CREAM}">Know what your gut is telling you</text>

       <text x="${PAD}" y="${PAD + 340}"
             font-family="${FONT_BODY}" font-size="32" fill="${MINT}"
             >Snap a meal, log how you feel, see what tracks with your symptoms.</text>

       <text x="${PAD}" y="${H - 58}"
             font-family="${FONT_BODY}" font-size="28" font-weight="bold"
             letter-spacing="1" fill="${CLAY}">${PUBLIC_HOST}</text>
     </svg>`
  );

const png = await sharp(plate()).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(OUT, png);

const { width, height } = await sharp(png).metadata();
console.log(
  `wrote public/og.png (${width}x${height}, ${(png.length / 1024).toFixed(1)} KB)\n` +
    `lockup at ${PAD},${PAD} — ${lockup.width}x${lockup.height}, ` +
    `symbol ${lockup.symbol.width}x${lockup.symbol.height}, cap ${CAP}`
);
