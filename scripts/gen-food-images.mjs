#!/usr/bin/env node
/**
 * Generate the SnapGut food illustration pack with Vertex AI Imagen.
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

import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "foods");
const LIST_FILE = path.join(__dirname, "food-list.txt");

const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const MODEL = process.env.IMAGEN_MODEL || "imagen-4.0-fast-generate-001";

// ---- the locked art direction (keep identical across the whole pack) ----
const STYLE = [
  "vintage botanical illustration",
  "hand-inked engraving with fine cross-hatched linework",
  "muted natural watercolor washes, sage green and warm terracotta accents",
  "flat plain cream paper background",
  "single centered subject, full item visible, generous margin",
  "scientific botanical plate aesthetic, antique field guide",
  "soft even lighting, no harsh shadows",
].join(", ");

const NEGATIVE = [
  "text",
  "labels",
  "letters",
  "numbers",
  "watermark",
  "signature",
  "border",
  "frame",
  "photograph",
  "photorealistic",
  "3d render",
  "glossy",
  "neon",
  "busy background",
  "multiple panels",
  "collage",
  "hands",
  "people",
  "plates",
  "cutlery",
].join(", ");

function promptFor(food) {
  return `A ${food}, illustrated as a ${STYLE}.`;
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

/** One Imagen predict call → base64 PNG. */
async function generate(client, project, food) {
  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const res = await client.request({
    url,
    method: "POST",
    data: {
      instances: [{ prompt: promptFor(food.name) }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "1:1",
        negativePrompt: NEGATIVE,
        personGeneration: "dont_allow",
        // Deterministic-ish style across the set. Imagen rejects seed when
        // watermarking is on, so disable it for a consistent pack.
        addWatermark: false,
        seed: 7,
      },
    },
  });

  const b64 = res.data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error(`no image returned (${JSON.stringify(res.data).slice(0, 200)})`);
  return Buffer.from(b64, "base64");
}

/** Run tasks with a small concurrency limit (Imagen has per-minute quotas). */
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
    foods = foods.filter((f) => !existsSync(path.join(OUT_DIR, `${f.slug}.png`)));
  }
  if (Number.isFinite(args.limit)) foods = foods.slice(0, args.limit);

  const existing = (await readdir(OUT_DIR).catch(() => [])).filter((f) => f.endsWith(".png"));
  console.log(`Pack: ${existing.length} existing · ${foods.length} to generate`);
  console.log(`Model: ${MODEL} (${LOCATION})`);

  if (foods.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (args.dryRun) {
    console.log("\n--- dry run ---");
    for (const f of foods) console.log(`  ${f.slug}.png  ←  ${f.name}`);
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
  await pool(foods, args.concurrency, async (food) => {
    try {
      const png = await generate(client, project, food);
      await writeFile(path.join(OUT_DIR, `${food.slug}.png`), png);
      ok++;
      console.log(`  ✓ ${food.slug}.png`);
    } catch (e) {
      failures.push({ food, message: e.message });
      console.warn(`  ✗ ${food.slug}: ${e.message}`);
    }
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
