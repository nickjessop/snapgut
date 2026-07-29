#!/usr/bin/env node
/**
 * Generate the SnapGut food illustration pack with Vertex AI (Gemini image models,
 * a.k.a. "Nano Banana").
 *
 * NOTE: we deliberately do NOT use Imagen — Google deprecated the Imagen models with
 * a shutdown date of 2026-08-17 and they already 404 on new projects. The Gemini
 * image models are the supported path.
 *
 * Style: vintage botanical-plate illustration, locked via STYLE so the whole set
 * feels like one cohesive collection. Run OFFLINE (not at request time) and commit
 * the output — the app then serves static assets with no runtime AI cost and no
 * third-party image licensing/attribution dependency.
 *
 * Setup:
 *   gcloud auth application-default login
 *   gcloud config set project YOUR_PROJECT_ID
 *   gcloud services enable aiplatform.googleapis.com
 *
 * Usage:
 *   node scripts/gen-food-images.mjs --dry-run          # show what it would generate
 *   node scripts/gen-food-images.mjs --limit 5          # try a small batch first
 *   node scripts/gen-food-images.mjs                    # generate everything missing
 *   node scripts/gen-food-images.mjs --only "Onion,Garlic"
 *   node scripts/gen-food-images.mjs --force --only Onion
 *
 * Resumable + idempotent: existing files are skipped unless --force.
 */

import { writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Deliberately OUTSIDE public/ so Vite never copies ~50 MB into dist/ (and the
// container). The pack is uploaded to GCS and streamed by the server at /foods/*.
const OUT_DIR = path.join(ROOT, "food-pack");
const LIST_FILE = path.join(__dirname, "food-list.txt");

// gemini-2.5-flash-image works in us-central1; gemini-3.1-flash-image is global-only.
const MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image";
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const HOST =
  LOCATION === "global"
    ? "aiplatform.googleapis.com"
    : `${LOCATION}-aiplatform.googleapis.com`;

// ---- the locked art direction (keep identical across the whole pack) ----
const STYLE = [
  "vintage botanical illustration style",
  "hand-inked engraving with fine cross-hatched linework",
  "muted natural watercolor washes",
  "antique field-guide plate aesthetic",
  "soft even lighting, no harsh shadows",
].join(", ");

// Framing rules: the FOOD is the subject, not the plant it grows on.
const FRAMING = [
  "the edible food item itself, exactly as it looks in a kitchen ready to eat or cook",
  "one single specimen isolated as a cut-out study, centered, filling about 85% of the frame",
  "pure solid white background, nothing else in the scene",
].join(", ");

const NEGATIVE = [
  "the whole growing plant",
  "foliage, stems, branches, vines or leaves (unless the leaf is the food itself)",
  "roots, soil, dirt or garden scenery",
  "flowers or blossoms (unless the flower is the food itself)",
  "live animals or birds",
  "text, labels, letters, numbers, captions",
  "watermark or signature",
  "borders or frames",
  "photographic or 3d-rendered look",
  "plates, bowls, cutlery, packaging",
  "hands or people",
  "multiple panels or collage",
  "shadows on the background",
].join(", ");

/**
 * Ambiguous names that a literal reading gets wrong (e.g. "Chicken" -> a live bird).
 * Maps the log's food name to the edible form we actually want illustrated.
 */
const SUBJECT_OVERRIDES = {
  chicken: "two raw boneless chicken breast fillets",
  "grilled chicken": "sliced grilled chicken breast",
  turkey: "a raw turkey breast fillet",
  beef: "a raw beef steak cut",
  "beef patty": "a cooked beef burger patty",
  pork: "a raw pork chop cut",
  lamb: "a raw lamb chop cut",
  duck: "a raw duck breast fillet",
  salmon: "a raw salmon fillet",
  tuna: "a raw tuna steak",
  cod: "a raw cod fillet",
  shrimp: "a few peeled raw shrimp",
  anchovies: "a few preserved anchovy fillets",
  egg: "two chicken eggs in shell, one cracked open showing the yolk",
  eggplant: "a single whole purple eggplant fruit, no plant",
  aubergine: "a single whole purple eggplant fruit, no plant",
  oats: "a small heap of rolled oat flakes",
  barley: "a small heap of pearl barley grains",
  quinoa: "a small heap of uncooked quinoa grains",
  "white rice": "a small heap of uncooked white rice grains",
  "brown rice": "a small heap of uncooked brown rice grains",
  wheat: "a small heap of wheat grains",
  corn: "a shucked ear of sweetcorn",
  sweetcorn: "a shucked ear of sweetcorn",
  mushroom: "a few whole button mushrooms",
  asparagus: "a small bundle of trimmed asparagus spears",
  artichoke: "a single trimmed globe artichoke head",
  beetroot: "a single trimmed beetroot bulb",
  celery: "a few trimmed celery stalks",
  ginger: "a fresh ginger rhizome",
  turmeric: "fresh turmeric rhizomes",
  cinnamon: "a few rolled cinnamon bark quills",
  "bay leaf": "a few dried bay leaves",
  "black pepper": "a small heap of black peppercorns",
  salt: "a small heap of coarse salt crystals",
  paprika: "a small heap of red paprika powder",
  cumin: "a small heap of cumin seeds",
  "curry powder": "a small heap of yellow curry powder",
  msg: "a small heap of white crystalline seasoning powder",
  "monosodium glutamate": "a small heap of white crystalline seasoning powder",
  // --- additives, thickeners, starches and fibres (gut-health relevant) ---
  inulin: "a small heap of fine white inulin fibre powder",
  "chicory root": "a chicory taproot beside a small heap of ground chicory powder",
  psyllium: "a small heap of pale psyllium husk flakes",
  "psyllium husk": "a small heap of pale psyllium husk flakes",
  "xanthan gum": "a small heap of fine white xanthan gum powder",
  "guar gum": "a small heap of fine off-white guar gum powder",
  pectin: "a small heap of fine white pectin powder",
  gelatin: "a stack of translucent gelatin sheets beside a heap of gelatin granules",
  "citric acid": "a small heap of white citric acid crystals",
  maltodextrin: "a small heap of fine white maltodextrin powder",
  "modified food starch": "a small heap of fine white starch powder",
  cornstarch: "a small heap of fine white cornstarch powder",
  "tapioca starch": "a small heap of fine white tapioca starch powder",
  "potato starch": "a small heap of fine white potato starch powder",
  "resistant starch": "a small heap of fine white starch powder",
  "baking powder": "a small heap of white baking powder beside a measuring spoon",
  "baking soda": "a small heap of white baking soda beside a measuring spoon",
  lecithin: "a small heap of golden soy lecithin granules",
  "soy lecithin": "a small heap of golden soy lecithin granules",
  "whey protein": "a scoop of pale whey protein powder",
  casein: "a scoop of pale casein protein powder",
  "food coloring": "three small glass vials of red, yellow and blue food colouring",
  gluten: "a ball of stretchy raw wheat gluten dough beside a heap of flour",
  "malt extract": "thick dark malt extract syrup in a small glass jar",
  "invert sugar": "clear thick sugar syrup in a small glass jar",
  "sugar alcohol": "a small heap of white crystalline sweetener powder",
  "yeast extract": "dark savoury yeast extract paste in a small glass jar",
  // --- stocks, broths and umami bases ---
  dashi: "a bowl of clear dashi broth beside a piece of dried kombu",
  "bouillon cube": "two wrapped-foil bouillon cubes, one unwrapped",
  "chicken stock": "a glass jar of golden chicken stock",
  "beef stock": "a glass jar of dark beef stock",
  "vegetable stock": "a glass jar of light vegetable stock",
  "bonito flakes": "a small heap of pale shaved bonito flakes",
  "sourdough starter": "bubbly sourdough starter in a glass jar",
  sugar: "a small heap of white sugar crystals",
  honey: "honey in a small glass jar with a dipper",
  "maple syrup": "maple syrup in a small glass bottle",
  molasses: "dark molasses in a small glass jar",
  stevia: "a small heap of white stevia powder",
  sorbitol: "a small heap of white crystalline sweetener powder",
  xylitol: "a small heap of white crystalline sweetener powder",
  mannitol: "a small heap of white crystalline sweetener powder",
  "artificial sweetener": "a small heap of white sweetener powder",
  "high-fructose corn syrup": "thick clear syrup in a small glass bottle",
  "agave syrup": "amber agave syrup in a small glass bottle",
  milk: "a glass of milk",
  "skim milk": "a glass of skim milk",
  "lactose-free milk": "a glass of milk",
  "almond milk": "a glass of almond milk beside a few almonds",
  "oat milk": "a glass of oat milk beside a few oat flakes",
  "soy milk": "a glass of soy milk beside a few soybeans",
  "coconut milk": "a glass of coconut milk beside a coconut half",
  cream: "a small pitcher of cream",
  butter: "a stick and pat of butter",
  kefir: "a glass of kefir",
  yogurt: "yogurt in a small bowl",
  "greek yogurt": "thick greek yogurt in a small bowl",
  coffee: "a cup of black coffee beside a few roasted coffee beans",
  espresso: "a small cup of espresso",
  "black tea": "a cup of black tea beside a few dried tea leaves",
  "green tea": "a cup of green tea beside a few dried green tea leaves",
  "peppermint tea": "a cup of tea beside a sprig of peppermint",
  "chamomile tea": "a cup of tea beside a few dried chamomile flowers",
  beer: "a glass of beer",
  ale: "a pint glass of amber ale",
  lager: "a pint glass of pale lager",
  stout: "a pint glass of dark stout",
  ipa: "a pint glass of hoppy IPA beer",
  wine: "a glass of wine",
  "red wine": "a glass of red wine",
  "white wine": "a glass of white wine",
  whiskey: "a glass of whiskey",
  vodka: "a glass of clear vodka",
  cider: "a glass of apple cider",
  kombucha: "a glass of kombucha",
  soda: "a glass of dark soda with bubbles",
  "diet soda": "a glass of soda with bubbles",
  "energy drink": "a tall can of energy drink",
  "orange juice": "a glass of orange juice beside an orange half",
  "apple juice": "a glass of apple juice beside an apple half",
  "sparkling water": "a glass of sparkling water",
  "olive oil": "olive oil in a small glass bottle beside a few olives",
  "vegetable oil": "clear cooking oil in a small glass bottle",
  "coconut oil": "coconut oil in a small glass jar",
  "sesame oil": "sesame oil in a small glass bottle beside sesame seeds",
  "palm oil": "reddish palm oil in a small glass bottle",
  "soy sauce": "soy sauce in a small glass bottle",
  "fish sauce": "fish sauce in a small glass bottle",
  vinegar: "vinegar in a small glass bottle",
  "balsamic vinegar": "dark balsamic vinegar in a small glass bottle",
  "hot sauce": "hot sauce in a small glass bottle",
  ketchup: "ketchup in a small glass dish",
  mustard: "mustard in a small glass dish",
  mayonnaise: "mayonnaise in a small glass dish",
  tahini: "tahini paste in a small glass dish",
  hummus: "hummus in a small bowl",
  pesto: "green pesto in a small glass jar",
  salsa: "red salsa in a small bowl",
  "peanut butter": "peanut butter in a small glass jar",
  "chili flakes": "a small heap of dried red chili flakes",
  miso: "miso paste in a small bowl",
  kimchi: "kimchi in a small bowl",
  sauerkraut: "sauerkraut in a small bowl",
  pickles: "a few pickled cucumbers",
  "vinegar pickles": "a few pickled cucumbers in brine",
  "aged cheese": "a wedge of aged hard cheese",
  "cured meat": "a few slices of cured meat",
  "dried apricots": "a few dried apricot halves",
  raisins: "a small heap of raisins",
  dates: "a few whole dates",
  prunes: "a few dried prunes",
  figs: "two fresh figs, one halved",
  cereal: "breakfast cereal flakes in a bowl",
  granola: "granola clusters in a bowl",
  muesli: "muesli in a bowl",
  chocolate: "a few squares of chocolate broken from a bar",
  "dark chocolate": "a few squares of dark chocolate",
  "milk chocolate": "a few squares of milk chocolate",
  chips: "a small pile of potato chips",
  popcorn: "a small pile of popped popcorn",
  pretzels: "a few salted pretzels",
  "protein bar": "a protein bar, one bite taken",
  smoothie: "a glass of thick fruit smoothie",
  soup: "a bowl of soup",
  salad: "a bowl of mixed leafy salad",
  "stir fry": "a bowl of mixed vegetable stir fry",
  curry: "a bowl of curry",
  sushi: "a few pieces of nigiri and maki sushi",
  ramen: "a bowl of ramen noodle soup",
  "instant ramen": "a block of dried instant ramen noodles beside its seasoning sachet",
  pho: "a bowl of pho noodle soup",
  "pad thai": "a plate of pad thai noodles",
  dumplings: "a few steamed dumplings",
  "spring rolls": "a few spring rolls",
  tacos: "two filled tacos",
  burrito: "a wrapped burrito, one end cut open",
  lasagna: "a slice of layered lasagna",
  "mac and cheese": "a bowl of macaroni and cheese",
  "fried rice": "a bowl of fried rice",
  omelette: "a folded omelette on its own",
  "scrambled eggs": "a serving of scrambled eggs",
  "poached egg": "a poached egg with a runny yolk",
  pancakes: "a short stack of pancakes",
  toast: "two slices of toasted bread",
  bagel: "a bagel, halved",
  croissant: "a single croissant",
  muffin: "a single muffin",
  cookie: "two round cookies",
  cake: "a slice of layer cake",
  pizza: "a single slice of pizza",
  burger: "a whole assembled burger",
  fries: "a portion of french fries",
  sandwich: "a sandwich cut in half",
  pasta: "a few pieces of dried penne and fusilli pasta, clearly tube and spiral shaped",
  "wheat noodles": "a bundle of dried wheat noodles",
  "rice noodles": "a bundle of dried rice noodles",
  couscous: "a small heap of couscous",
  "corn tortilla": "a stack of corn tortillas",
  "wheat bread": "a loaf of wheat bread with one slice cut",
  "sourdough bread": "a round sourdough loaf with one slice cut",
  "rye bread": "a dark rye loaf with one slice cut",
  lentils: "a small heap of dried lentils",
  chickpeas: "a small heap of dried chickpeas",
  "black beans": "a small heap of dried black beans",
  "kidney beans": "a small heap of dried kidney beans",
  "baked beans": "baked beans in tomato sauce in a small bowl",
  tofu: "a block of firm tofu, one slice cut",
  tempeh: "a block of tempeh, one slice cut",
  "chia seeds": "a small heap of chia seeds",
  flaxseed: "a small heap of flaxseeds",
  "sunflower seeds": "a small heap of shelled sunflower seeds",
  "pumpkin seeds": "a small heap of shelled pumpkin seeds",
};

function subjectFor(name) {
  return SUBJECT_OVERRIDES[name.trim().toLowerCase()] || name;
}

function promptFor(food) {
  // Gemini image models take one natural-language instruction (no separate
  // negativePrompt param), so framing + exclusions are folded into the prompt.
  return (
    `Generate a square illustration of ${subjectFor(food)}.\n\n` +
    `Subject and framing: ${FRAMING}.\n\n` +
    `Style: ${STYLE}.\n\n` +
    `Absolutely do not include: ${NEGATIVE}.`
  );
}

// ---- helpers ----

/** Must match slugify() in src/foodImages.ts. */
function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, limit: Infinity, only: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function loadFoods() {
  const text = await readFile(LIST_FILE, "utf8");
  const seen = new Set();
  const foods = [];
  for (const line of text.split("\n")) {
    const name = line.trim();
    if (!name || name.startsWith("#")) continue;
    const slug = slugify(name);
    if (!slug || seen.has(slug)) continue; // de-dupe by slug
    seen.add(slug);
    foods.push({ name, slug });
  }
  return foods;
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

/** One Gemini image generateContent call → image Buffer + mime type. */
async function generate(client, project, food) {
  const url =
    `https://${HOST}/v1/projects/${project}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const res = await client.request({
    url,
    method: "POST",
    data: {
      contents: [{ role: "user", parts: [{ text: promptFor(food.name) }] }],
      generationConfig: { responseModalities: ["IMAGE"], temperature: 0.2 },
    },
  });

  const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) {
    const reason = res.data?.candidates?.[0]?.finishReason || "no inlineData";
    throw new Error(`no image returned (${reason})`);
  }
  return {
    buffer: Buffer.from(img.inlineData.data, "base64"),
    mime: img.inlineData.mimeType || "image/png",
  };
}

/**
 * Post-process: knock the white background out to transparency, trim the excess
 * margin, downscale, and encode as WebP with alpha.
 *
 * The model returns an opaque 1024px image (~1.2 MB); these render around 46px but
 * we keep THUMB_PX (default 256, ~3x2x) so they stay crisp on retina and can be
 * reused larger later. Transparency lets the app control the backdrop per theme.
 */
const THUMB_PX = Number(process.env.THUMB_PX || 256);
// How close to white counts as background (0-255 distance from pure white).
const WHITE_TOLERANCE = Number(process.env.WHITE_TOLERANCE || 26);

async function toTransparentWebp(pngBuffer) {
  const sharp = (await import("sharp")).default;

  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  // Flood-fill inward from the edges so only the *background* becomes transparent
  // (white highlights inside the subject, e.g. an egg or a glass, are preserved).
  const isBg = new Uint8Array(width * height);
  const stack = [];
  const nearWhite = (i) => {
    const r = data[i * channels];
    const g = data[i * channels + 1];
    const b = data[i * channels + 2];
    return 255 - r <= WHITE_TOLERANCE && 255 - g <= WHITE_TOLERANCE && 255 - b <= WHITE_TOLERANCE;
  };
  for (let x = 0; x < width; x++) {
    stack.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, y * width + width - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    if (isBg[i] || !nearWhite(i)) continue;
    isBg[i] = 1;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - width);
    if (y < height - 1) stack.push(i + width);
  }
  for (let i = 0; i < width * height; i++) {
    if (isBg[i]) data[i * channels + 3] = 0;
  }

  return sharp(data, { raw: { width, height, channels } })
    .trim({ threshold: 1 }) // crop the now-transparent margin
    .resize(THUMB_PX, THUMB_PX, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 88, effort: 5 })
    .toBuffer();
}

/** Run tasks with a small concurrency limit (image models have per-minute quotas). */
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

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/gen-food-images.mjs [--dry-run] [--force] [--limit N]\n" +
        "                                       [--only \"Onion,Garlic\"] [--concurrency N]"
    );
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  let foods = await loadFoods();
  if (args.only) {
    const want = new Set(args.only.map(slugify));
    foods = foods.filter((f) => want.has(f.slug));
  }
  if (!args.force) {
    foods = foods.filter((f) => !existsSync(path.join(OUT_DIR, `${f.slug}.webp`)));
  }
  if (Number.isFinite(args.limit)) foods = foods.slice(0, args.limit);

  const existing = (await readdir(OUT_DIR).catch(() => [])).filter((f) => f.endsWith(".webp"));
  console.log(`Pack: ${existing.length} existing · ${foods.length} to generate`);
  console.log(`Model: ${MODEL} (${LOCATION})`);

  if (foods.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (args.dryRun) {
    console.log("\n--- dry run ---");
    for (const f of foods) console.log(`  ${f.slug}.webp  ←  ${f.name}`);
    console.log(`\nPrompt example:\n  ${promptFor(foods[0].name)}`);
    console.log(`\nEstimated cost: ~$${(foods.length * 0.02).toFixed(2)} (at ~$0.02/image)`);
    return;
  }

  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const project = await resolveProject(auth);
  const client = await auth.getClient();
  console.log(`Project: ${project}\n`);

  let ok = 0;
  const failures = [];
  const ATTEMPTS = 3; // most failures are transient (NO_IMAGE / rate limit / reset)
  await pool(foods, args.concurrency, async (food) => {
    let lastErr;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const { buffer } = await generate(client, project, food);
        const webp = await toTransparentWebp(buffer);
        const file = path.join(OUT_DIR, `${food.slug}.webp`);
        await writeFile(file, webp);
        ok++;
        console.log(`  ✓ ${food.slug}.webp  (${(webp.length / 1024).toFixed(0)}kb)`);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1500 * attempt)); // simple backoff
        }
      }
    }
    failures.push({ food, message: lastErr.message });
    console.warn(`  ✗ ${food.slug}: ${lastErr.message}`);
  });

  console.log(`\nDone: ${ok} generated, ${failures.length} failed.`);
  if (failures.length) {
    console.log("Retry the failures with:");
    console.log(`  node scripts/gen-food-images.mjs --only "${failures.map((f) => f.food.name).join(",")}"`);
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
