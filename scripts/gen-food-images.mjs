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
const OUT_DIR = path.join(ROOT, "public", "foods");
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
  // Gemini image models take one natural-language instruction (no separate
  // negativePrompt param), so the exclusions are folded into the prompt.
  return (
    `Generate a square illustration of ${food}.\n\n` +
    `Style: ${STYLE}.\n\n` +
    `Do not include: ${NEGATIVE}.`
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
 * The model returns 1024x1024 (~1.2 MB) but these render as ~46px thumbnails, so
 * downscale to THUMB_PX to keep the committed pack small. Uses macOS `sips`; on
 * other platforms the full-size image is kept (with a warning).
 */
const THUMB_PX = Number(process.env.THUMB_PX || 128);
let sipsWarned = false;

async function downscale(file) {
  try {
    await execFileP("sips", ["-Z", String(THUMB_PX), file, "--out", file]);
    return true;
  } catch {
    if (!sipsWarned) {
      console.warn(`  ! could not downscale (no 'sips'); keeping full-size images`);
      sipsWarned = true;
    }
    return false;
  }
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
      const { buffer } = await generate(client, project, food);
      const file = path.join(OUT_DIR, `${food.slug}.png`);
      await writeFile(file, buffer);
      await downscale(file);
      const { size } = await stat(file);
      ok++;
      console.log(`  ✓ ${food.slug}.png  (${(size / 1024).toFixed(0)}kb)`);
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
