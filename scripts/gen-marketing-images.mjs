#!/usr/bin/env node
/**
 * PROVENANCE SCRIPT — not part of the build.
 *
 * This is the script that generated the assets this project ships (the
 * marketing illustrations), kept so the process is documented and reproducible
 * rather than because anything runs it. It needs Google Cloud credentials and
 * Vertex AI access, and its dependencies (`@google-cloud/vertexai`,
 * `google-auth-library`) are not installed by default, so it will not run
 * against a plain checkout. No npm script invokes it, and nothing in the app
 * imports it.
 */
/**
 * Generate the marketing homepage illustrations with Vertex AI (Gemini image
 * models), using the same workflow and the same art direction as the food pack.
 *
 * `scripts/gen-food-images.mjs` is the original and remains the reference for
 * the locked style. STYLE below is copied from it verbatim on purpose: the
 * marketing art has to read as the same collection as the 3,036 food
 * thumbnails, and the only way to guarantee that is to send the same style
 * clause. The post-process (white knockout → trim → WebP with alpha) is the
 * same too. It is duplicated rather than imported because that script runs its
 * own `main()` on import; factoring a shared module out of a pipeline that has
 * already produced the whole pack is a change with no upside here.
 *
 * What differs from the food pack:
 *   · subjects are objects and one grouped still life, not single foods
 *   · framing is per image, since the hero is landscape and the rest are square
 *   · output width is per image, at 2x the size the page displays, so the
 *     illustrations stay crisp on a retina screen
 *   · output lands in `public/img/`, which Vite copies verbatim into the
 *     Build_Output and the Origin_Server serves from `/img/*` as OTHER_STATIC.
 *     `vite/pwa.js` keeps them out of the Precache_Manifest, so they cost a
 *     marketing visitor one request each and cost an app install nothing.
 *
 * Setup (same as the food pack):
 *   gcloud auth application-default login
 *   gcloud config set project YOUR_PROJECT_ID
 *   gcloud services enable aiplatform.googleapis.com
 *
 * Usage:
 *   node scripts/gen-marketing-images.mjs --dry-run
 *   node scripts/gen-marketing-images.mjs --only hero-meal-study
 *   node scripts/gen-marketing-images.mjs                 # everything missing
 *   node scripts/gen-marketing-images.mjs --force         # redraw everything
 *
 * Resumable and idempotent: existing files are skipped unless --force. On
 * success it prints the exact `<img>` markup for each file, dimensions included,
 * because the homepage has to declare intrinsic width and height (Req 15.3) and
 * `src/marketing.budget.test.ts` requires them to be integers.
 */

import { writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "img");

const MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image";
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const HOST =
  LOCATION === "global"
    ? "aiplatform.googleapis.com"
    : `${LOCATION}-aiplatform.googleapis.com`;

// ---- the locked art direction (identical to the food pack) ----
const STYLE = [
  "vintage botanical illustration style",
  "hand-inked engraving with fine cross-hatched linework",
  "muted natural watercolor washes",
  "antique field-guide plate aesthetic",
  "soft even lighting, no harsh shadows",
].join(", ");

/** Exclusions every marketing image shares. */
const NEGATIVE_BASE = [
  "text, labels, letters, numbers, captions",
  "watermark or signature",
  "borders or frames",
  "photographic or 3d-rendered look",
  "hands or people",
  "multiple panels or collage",
  "shadows on the background",
  "user interface, screens, app mockups, phone bodies",
].join(", ");

/** The default framing: a single object as a centred cut-out study. */
const FRAMING_OBJECT = [
  "one single object isolated as a cut-out study, centered, filling about 85% of the frame",
  "pure solid white background, nothing else in the scene",
].join(", ");

/**
 * The six illustrations the homepage asks for.
 *
 * `width` is the pixel width written to disk, at 2x the intended display size —
 * `display` is what the markup declares. Subjects lean on classic engraving
 * objects (a bellows camera, a balance, a lens) rather than on anything
 * screen-shaped: a drawn UI would date instantly and would also be a claim
 * about what the product looks like.
 */
const IMAGES = [
  {
    // The foods sit on an instant print, which is the product's own gesture:
    // the app starts at a camera pointed at a meal. "borders or frames" has to
    // come out of the exclusions for this one — the print's white border is the
    // subject, not an added frame.
    slug: "hero-polaroid",
    width: 940,
    display: 460,
    // Square, not 4:3: an instant print is portrait (a square image over a wide
    // bottom band), so a landscape box would sit it in two dead side margins.
    aspect: 1,
    alt:
      "An illustrated instant camera print showing everyday meal foods: bread, " +
      "yogurt, a tomato, cheese, oats and a cup of coffee",
    subject:
      "a single instant camera photo print lying at a slight angle — a square image area " +
      "inside a pale instant-film border with a wider band along the bottom, and a fine " +
      "thin grey keyline drawn around the print's outer edge — and the photo inside it " +
      "shows a compact still-life group of everyday meal foods clustered together: a " +
      "thick slice of sourdough bread, a small bowl of plain yogurt, a ripe tomato, a " +
      "wedge of hard cheese, a scatter of rolled oat flakes, and a cup of black coffee",
    framing: [
      "one single instant print, tilted a few degrees, filling about 88% of the frame",
      "the film border is clean and empty, the photograph sits inside it",
      // Two things the knockout depends on. The area around the print has to be
      // pure white or there is nothing for the flood fill to remove — an earlier
      // run put the print on a dark surface and the whole frame stayed opaque.
      // And the print needs its own outline, because a pure-white film border
      // against a pure-white background would be eaten by the same fill.
      "the area surrounding the print is pure solid white, empty, with no surface, " +
        "no tabletop, no shadow and no tone of any kind",
      "the print is separated from that white by its own thin grey outline",
    ].join(", "),
    negativeOverride: [
      "text, labels, letters, numbers, captions, handwriting on the print",
      "watermark or signature",
      "photographic or 3d-rendered look",
      "hands or people",
      "multiple prints, a stack of prints, a collage",
      "growing plants, foliage, soil, garden scenery",
      "cutlery, place settings",
      "a camera body, a phone",
      "a dark background, a black background, a coloured background",
      "a table, a desk, a wooden surface, a cloth beneath the print",
      "a drop shadow or cast shadow around the print",
      "a vignette or gradient behind the print",
    ].join(", "),
  },
  {
    slug: "step-camera",
    width: 420,
    display: 116,
    alt: "",
    subject:
      "a modern compact mirrorless camera seen from a three-quarter front angle, clean " +
      "minimal body, one short prime lens pointing toward the viewer, no visible branding",
    framing: [
      "a square composition: the camera is turned slightly and tilted so its body and lens " +
        "together fill the square, as tall as it is wide",
      "one single object isolated as a cut-out study, centered, filling about 90% of the frame",
      "pure solid white background, nothing else in the scene",
    ].join(", "),
    extraNegative:
      "vintage or antique camera, bellows, film advance lever, tripod, flash bracket, " +
      "a wide flat side-on silhouette",
  },
  {
    slug: "step-journal",
    width: 420,
    display: 116,
    alt: "",
    subject:
      "a modern hardcover notebook with rounded corners and an elastic band closure, lying " +
      "closed at a slight angle, with a slim modern pen resting across it",
    extraNegative: "writing, handwriting, printed lines, ruled lines, page numbers, quill",
  },
  {
    // Replaces the magnifying glass: the step is about reading a ranking, and a
    // lens says "search" rather than "compare".
    slug: "step-chart",
    width: 420,
    display: 116,
    alt: "",
    subject:
      "a simple modern bar chart: four clean rounded vertical bars of increasing height " +
      "standing side by side on a thin baseline",
    extraNegative:
      "axis labels, tick marks, gridlines, numbers, percentages, a screen or device around " +
      "the chart, pie chart, line graph",
  },
  {
    slug: "card-fast",
    width: 256,
    display: 64,
    alt: "",
    subject: "a modern minimal stopwatch seen from the front, clean dial with no markings",
    extraNegative: "numerals on the dial, tick marks, hands pointing at numbers, hourglass",
  },
  {
    slug: "card-honest",
    width: 256,
    display: 64,
    alt: "",
    subject:
      "a clean modern balance scale seen from the front: two shallow empty pans hanging " +
      "level from a simple beam, on a slender upright column rising from a round base",
    framing: [
      "a square composition: the column and base give the scale as much height as the beam " +
        "gives it width, so it fills the square",
      "one single object isolated as a cut-out study, centered, filling about 90% of the frame",
      "pure solid white background, nothing else in the scene",
    ].join(", "),
    extraNegative:
      "weights, coins, produce in the pans, digital scale, ornate brasswork, " +
      "a wide flat short silhouette, a beam without a stand",
  },
  {
    slug: "card-private",
    width: 256,
    display: 64,
    alt: "",
    subject: "a modern minimal closed padlock with a smooth rounded shackle",
    extraNegative: "chains, safes, keyholes in doors, combination dials, keys",
  },
  {
    // The two section scenes carry a column each, so they are compositions
    // rather than single objects — the copy above them got shorter and the art
    // is what fills the room that left.
    slug: "measure-scene",
    width: 920,
    display: 460,
    aspect: 4 / 3,
    alt:
      "An illustrated bench scene: a balance scale beside stoppered jars, a notebook " +
      "and a cup of tea",
    subject:
      "a tidy apothecary bench scene: a balance scale with two level empty pans at the " +
      "centre, three stoppered glass jars of dried herbs to one side, an open notebook " +
      "and a small cup of tea to the other, a folded cloth beneath them",
    framing: [
      "a horizontal bench-top scene, objects arranged across one surface at slightly " +
        "different depths, the balance tallest at the centre",
      "the group fills about 92% of the frame and is balanced left to right",
      "pure solid white background behind the objects, no wall, no room, no table edge",
    ].join(", "),
    extraNegative:
      "labels on the jars, printed text, a laboratory, scientific instruments, microscopes, " +
      "test tubes, a person",
  },
  {
    slug: "privacy-scene",
    width: 920,
    display: 460,
    aspect: 4 / 3,
    alt:
      "An illustrated desk scene: a closed keepsake box with a small brass lock, a key " +
      "on a ring, and a potted herb",
    subject:
      "a calm desk-corner scene: a closed wooden keepsake box with a small brass latch " +
      "and lock at the centre, one small key on a ring lying in front of it, a short " +
      "potted herb to one side, and a closed notebook to the other",
    framing: [
      "a horizontal desk-top scene, objects arranged across one surface at slightly " +
        "different depths, the box largest at the centre",
      "the group fills about 92% of the frame and is balanced left to right",
      "pure solid white background behind the objects, no wall, no room, no table edge",
    ].join(", "),
    extraNegative:
      "chains, safes, vaults, a computer, a phone, printed text on the notebook, a person",
  },
];

function promptFor(image) {
  const framing = image.framing || FRAMING_OBJECT;
  // `negativeOverride` replaces the shared exclusions outright, for the one
  // subject whose own artwork is a white border and so cannot forbid frames.
  const negative =
    image.negativeOverride ??
    (image.extraNegative ? `${NEGATIVE_BASE}, ${image.extraNegative}` : NEGATIVE_BASE);
  return (
    `Generate an illustration of ${image.subject}.\n\n` +
    `Subject and framing: ${framing}.\n\n` +
    `Style: ${STYLE}.\n\n` +
    `Absolutely do not include: ${negative}.`
  );
}

// ---- helpers ----

function parseArgs(argv) {
  const args = { dryRun: false, force: false, only: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function resolveProject(auth) {
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (fromEnv) return fromEnv;
  const detected = await auth.getProjectId().catch(() => null);
  if (!detected) {
    throw new Error(
      "No project found. Set GOOGLE_CLOUD_PROJECT or run: gcloud config set project YOUR_PROJECT_ID"
    );
  }
  return detected;
}

/** One Gemini image generateContent call → image Buffer. */
async function generate(client, project, image) {
  const url =
    `https://${HOST}/v1/projects/${project}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const res = await client.request({
    url,
    method: "POST",
    data: {
      contents: [{ role: "user", parts: [{ text: promptFor(image) }] }],
      generationConfig: { responseModalities: ["IMAGE"], temperature: 0.2 },
    },
  });

  const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) {
    const reason = res.data?.candidates?.[0]?.finishReason || "no inlineData";
    throw new Error(`no image returned (${reason})`);
  }
  return Buffer.from(img.inlineData.data, "base64");
}

const WHITE_TOLERANCE = Number(process.env.WHITE_TOLERANCE || 26);

/**
 * Knock the white background out to transparency, trim the margin, then fit the
 * artwork into an exact `width` x `width / aspect` box and encode as WebP.
 *
 * The box is enforced rather than inherited. A generated drawing's proportions
 * are not predictable — the same prompt produced a 5.5:1 strip on one run — and
 * three step illustrations that each come back a different shape will not sit in
 * a row. Fitting inside a fixed box with `contain` scales without distorting and
 * pads the remainder with transparency, which costs nothing on the page and
 * makes the declared width/height a constant instead of something to re-read
 * after every regeneration.
 *
 * The flood fill runs inward from the edges so only the *background* goes
 * transparent: white inside the subject (a page of the notebook, a highlight on
 * the brass) survives.
 */
async function toTransparentWebp(pngBuffer, width, aspect = 1) {
  const sharp = (await import("sharp")).default;

  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: w, height: h, channels } = info;
  const isBg = new Uint8Array(w * h);
  const stack = [];
  const nearWhite = (i) =>
    255 - data[i * channels] <= WHITE_TOLERANCE &&
    255 - data[i * channels + 1] <= WHITE_TOLERANCE &&
    255 - data[i * channels + 2] <= WHITE_TOLERANCE;

  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (isBg[i] || !nearWhite(i)) continue;
    isBg[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (isBg[i]) data[i * channels + 3] = 0;

  const buffer = await sharp(data, { raw: { width: w, height: h, channels } })
    .trim({ threshold: 1 })
    .resize(width, Math.round(width / aspect), {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 88, effort: 6 })
    .toBuffer();

  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width, height: meta.height };
}

async function pool(items, limit, worker) {
  let i = 0;
  const results = [];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx).catch((e) => ({ error: e }));
    }
  });
  await Promise.all(runners);
  return results;
}

/** The markup the homepage needs, so the declared box matches the file exactly. */
const imgTag = (image, box) => {
  const displayW = image.display;
  const displayH = Math.round((box.height * displayW) / box.width);
  return (
    `<img src="/img/${image.slug}.webp" alt="${image.alt}"` +
    ` width="${displayW}" height="${displayH}" loading="lazy" decoding="async" />`
  );
};

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/gen-marketing-images.mjs [--dry-run] [--force]\n" +
        '                                            [--only "hero-meal-study"] [--concurrency N]'
    );
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  let images = IMAGES;
  if (args.only) {
    const want = new Set(args.only);
    images = images.filter((i) => want.has(i.slug));
    const unknown = [...want].filter((s) => !IMAGES.some((i) => i.slug === s));
    if (unknown.length) throw new Error(`unknown slug(s): ${unknown.join(", ")}`);
  }
  if (!args.force) {
    images = images.filter((i) => !existsSync(path.join(OUT_DIR, `${i.slug}.webp`)));
  }

  const existing = (await readdir(OUT_DIR).catch(() => [])).filter((f) => f.endsWith(".webp"));
  console.log(`Marketing art: ${existing.length} existing · ${images.length} to generate`);
  console.log(`Model: ${MODEL} (${LOCATION})`);

  if (images.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (args.dryRun) {
    console.log("\n--- dry run ---");
    for (const i of images) console.log(`  ${i.slug}.webp  (${i.width}px, shown at ${i.display}px)`);
    console.log(`\nPrompt example:\n${promptFor(images[0])}`);
    console.log(`\nEstimated cost: ~$${(images.length * 0.02).toFixed(2)} (at ~$0.02/image)`);
    return;
  }

  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const project = await resolveProject(auth);
  const client = await auth.getClient();
  console.log(`Project: ${project}\n`);

  const tags = [];
  let ok = 0;
  const failures = [];
  const ATTEMPTS = 3;
  await pool(images, args.concurrency, async (image) => {
    let lastErr;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const png = await generate(client, project, image);
        const box = await toTransparentWebp(png, image.width, image.aspect ?? 1);
        await writeFile(path.join(OUT_DIR, `${image.slug}.webp`), box.buffer);
        ok++;
        tags.push({ slug: image.slug, tag: imgTag(image, box), box });
        console.log(
          `  ✓ ${image.slug}.webp  ${box.width}x${box.height}  (${(box.buffer.length / 1024).toFixed(0)}kb)`
        );
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    failures.push({ image, message: lastErr.message });
    console.warn(`  ✗ ${image.slug}: ${lastErr.message}`);
  });

  console.log(`\nDone: ${ok} generated, ${failures.length} failed.`);

  if (tags.length) {
    console.log("\nMarkup (intrinsic box halved for retina; integers as Req 15.3 needs):");
    for (const { slug, tag } of tags.sort((a, b) => a.slug.localeCompare(b.slug))) {
      console.log(`\n  ${tag}`);
    }
  }
  if (failures.length) {
    console.log(
      `\nRetry: node scripts/gen-marketing-images.mjs --only "${failures.map((f) => f.image.slug).join(",")}"`
    );
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
