#!/usr/bin/env node
/**
 * Build the canonical food dictionary: server/food-dict.json
 *
 * This replaces two fragile string-matching layers with one generated artifact:
 *   - image pairing        (was: slug guessing + 404 probing)
 *   - FODMAP/trigger tags  (was: substring keywords, e.g. "almond milk" -> lactose
 *                           because it contains "milk", "pineapple" -> fructose
 *                           because it contains "apple")
 *
 * The dictionary lives SERVER-side. /api/recognize canonicalises each ingredient at
 * recognition time and stores the canonical id on the event, so the client stays lean
 * and everything downstream (images, scoring, tags) joins on one id.
 *
 * Uses a Gemini *text* model for synonyms + tags (cheap — well under a dollar).
 *
 * Usage:
 *   node scripts/gen-food-dict.mjs --dry-run
 *   node scripts/gen-food-dict.mjs              # build/refresh the dictionary
 *   node scripts/gen-food-dict.mjs --limit 100  # partial run while iterating
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIST_FILE = path.join(__dirname, "food-list.txt");
const PACK_DIR = path.join(ROOT, "food-pack");
const OUT_FILE = path.join(ROOT, "server", "food-dict.json");

const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const MODEL = process.env.TEXT_MODEL || "gemini-2.5-flash";
const HOST =
  LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;

const BATCH = 25; // foods per model call
const CONCURRENCY = 4;

// Must stay in sync with TriggerGroup in src/fodmap.ts.
const TAGS = [
  "fructans",
  "gos",
  "lactose",
  "fructose",
  "polyols",
  "caffeine",
  "alcohol",
  "high_fat",
  "spicy",
  "carbonation",
  "histamine",
];

/**
 * Near-duplicate canonical entries to collapse: `slug -> canonical slug`. Both names
 * ended up in food-list.txt for the same food, which would otherwise split
 * aggregation ("MSG" and "Monosodium glutamate" counted as two different foods).
 * The loser is dropped as a food and registered as a synonym of the winner.
 */
const MERGE = {
  "monosodium-glutamate": "msg",
  // UK "coriander" (the leaf) is US "cilantro". The SEED stays separate as
  // coriander-seed, since it's a different ingredient with different tags.
  coriander: "cilantro",
  "coriander-leaves": "cilantro",
  "fresh-coriander": "cilantro",
  "psyllium": "psyllium-husk",
  "bicarbonate-of-soda": "baking-soda",
  "sodium-bicarbonate": "baking-soda",
  "corn-flour": "cornstarch",
  "corn-starch": "cornstarch",
  "soy-lecithin": "lecithin",
};

export function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function loadCanonicalFoods() {
  const text = await readFile(LIST_FILE, "utf8");
  const seen = new Map();
  for (const line of text.split("\n")) {
    const name = line.trim();
    if (!name || name.startsWith("#")) continue;
    const slug = slugify(name);
    if (slug && !seen.has(slug)) seen.set(slug, name);
  }
  return [...seen.entries()].map(([slug, display]) => ({ slug, display }));
}

function promptFor(batch) {
  return (
    `For each food below, return its common synonyms and which digestive trigger ` +
    `groups it belongs to.\n\n` +
    `Foods:\n${batch.map((f, i) => `${i + 1}. ${f.display}`).join("\n")}\n\n` +
    `Trigger groups (use ONLY these ids, omit any that don't apply):\n` +
    `- fructans: wheat/rye/onion/garlic-type fructan load\n` +
    `- gos: galacto-oligosaccharides (legumes, cashews, pistachios)\n` +
    `- lactose: contains meaningful lactose (DAIRY ONLY — plant milks do NOT)\n` +
    `- fructose: excess free fructose (apples, pears, mango, honey, HFCS)\n` +
    `- polyols: sorbitol/mannitol/xylitol (stone fruit, mushrooms, cauliflower, sugar-free)\n` +
    `- caffeine\n- alcohol\n- high_fat: notably high fat/fried\n- spicy: capsaicin heat\n` +
    `- carbonation: fizzy\n- histamine: aged/fermented/cured/leftover-prone\n\n` +
    `Rules:\n` +
    `- Be accurate per FODMAP evidence for a TYPICAL SERVING. Do not guess from the ` +
    `spelling of the word (pineapple is NOT high fructose; almond milk has NO lactose).\n` +
    `- Most plain vegetables, meats, fish, eggs, rice and oils have NO trigger groups: ` +
    `return an empty array.\n` +
    `- synonyms: other common English names, regional variants, plurals and obvious ` +
    `recogniser outputs. Lowercase. Max 6. Do not repeat the food's own name. ` +
    `Omit if none.\n\n` +
    `Return ONLY a JSON array, one object per input food, in the same order:\n` +
    `[{"name":"<the food>","synonyms":["..."],"tags":["..."]}]`
  );
}

async function askBatch(client, project, batch) {
  const url =
    `https://${HOST}/v1/projects/${project}/locations/${LOCATION}` +
    `/publishers/google/models/${MODEL}:generateContent`;
  const res = await client.request({
    url,
    method: "POST",
    data: {
      contents: [{ role: "user", parts: [{ text: promptFor(batch) }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    },
  });
  const text = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "[]";
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("not an array");
  return arr;
}

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  });
  await Promise.all(runners);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  let foods = await loadCanonicalFoods();
  if (Number.isFinite(limit)) foods = foods.slice(0, limit);

  const packSlugs = new Set(
    existsSync(PACK_DIR)
      ? readdirSync(PACK_DIR).filter((f) => f.endsWith(".webp")).map((f) => f.replace(/\.webp$/, ""))
      : []
  );

  console.log(`Foods: ${foods.length} · images on disk: ${packSlugs.size}`);
  if (dryRun) {
    const sample = foods.slice(0, BATCH);
    console.log(`\nExample prompt:\n${promptFor(sample).slice(0, 700)}…`);
    console.log(`\nText-only; expect well under $1 total.`);
    return;
  }

  const entries = new Map(); // slug -> { display, syn, tags, img, done }
  for (const f of foods) {
    entries.set(f.slug, {
      display: f.display,
      syn: [],
      tags: [],
      img: packSlugs.has(f.slug),
      done: false,
    });
  }

  // Resume: reuse anything an earlier run already resolved, so an interrupted build
  // (this takes a while) doesn't start from scratch.
  let resumed = 0;
  if (existsSync(OUT_FILE) && !args.includes("--force")) {
    try {
      const prev = JSON.parse(await readFile(OUT_FILE, "utf8"));
      const prevSyn = prev.synonyms || {};
      const bySlug = new Map();
      for (const [syn, canon] of Object.entries(prevSyn)) {
        if (!bySlug.has(canon)) bySlug.set(canon, []);
        bySlug.get(canon).push(syn);
      }
      for (const [slug, e] of entries) {
        const p = prev.foods?.[slug];
        if (!p) continue;
        // "done" = the model gave us something for this food previously.
        const syn = bySlug.get(slug) || [];
        if ((p.tags && p.tags.length) || syn.length) {
          e.tags = p.tags || [];
          e.syn = syn;
          e.done = true;
          resumed++;
        }
      }
      if (resumed) console.log(`Resuming: ${resumed} foods already resolved.`);
    } catch {
      /* unreadable previous dict — just rebuild */
    }
  }

  // Only ask the model about foods we don't already have data for.
  const todo = foods.filter((f) => !entries.get(f.slug).done);
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  console.log(`To resolve: ${todo.length} foods in ${batches.length} batches`);

  if (batches.length === 0) {
    await save(entries, 0);
    console.log("Nothing to resolve — dictionary rebuilt from existing data.");
    return;
  }

  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const project = process.env.GOOGLE_CLOUD_PROJECT || (await auth.getProjectId());
  const client = await auth.getClient();


  let done = 0;
  let failed = 0;
  await pool(batches, CONCURRENCY, async (batch) => {
    let rows = null;
    for (let attempt = 1; attempt <= 3 && !rows; attempt++) {
      try {
        rows = await askBatch(client, project, batch);
      } catch (e) {
        if (attempt === 3) {
          failed += batch.length;
          console.warn(`  ! batch failed: ${e.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 1200 * attempt));
        }
      }
    }
    if (rows) {
      // Match by slug where possible, else fall back to positional order.
      rows.forEach((row, idx) => {
        const target = entries.get(slugify(row?.name ?? "")) ? slugify(row.name) : batch[idx]?.slug;
        const e = target && entries.get(target);
        if (!e) return;
        e.syn = [
          ...new Set(
            (Array.isArray(row.synonyms) ? row.synonyms : [])
              .filter((s) => typeof s === "string")
              .map((s) => slugify(s))
              .filter((s) => s && s !== target && s.length > 1)
          ),
        ].slice(0, 6);
        e.tags = [
          ...new Set((Array.isArray(row.tags) ? row.tags : []).filter((t) => TAGS.includes(t))),
        ];
      });
    }
    for (const f of batch) entries.get(f.slug).done = true;
    done += batch.length;
    if (done % 250 < BATCH) {
      console.log(`  …${done}/${todo.length}`);
      await save(entries, failed); // checkpoint, so an interrupt doesn't lose work
    }
  });

  await save(entries, failed);
}

/** Write the dictionary (safe to call repeatedly so progress survives interruption). */
async function save(entries, failed) {
  // Work on a copy: save() runs mid-build as a checkpoint, so it must never mutate
  // the live entry map (the generation loop is still iterating it).
  const out = new Map([...entries].map(([slug, e]) => [slug, { ...e, syn: [...e.syn] }]));

  // Collapse near-duplicates: fold the loser's synonyms/tags into the winner, then
  // drop it as a canonical food (it becomes a synonym below).
  for (const [from, to] of Object.entries(MERGE)) {
    const loser = out.get(from);
    const winner = out.get(to);
    if (!loser || !winner || from === to) continue;
    winner.syn = [...new Set([...winner.syn, from, ...loser.syn])];
    if (!winner.tags.length) winner.tags = loser.tags;
    out.delete(from);
  }

  // Build the synonym -> canonical index, refusing to clobber a real canonical food.
  const synIndex = {};
  for (const [slug, e] of out) {
    for (const s of e.syn) {
      if (out.has(s) || synIndex[s]) continue; // never shadow a canonical id
      synIndex[s] = slug;
    }
  }

  const dict = {
    version: 1,
    generatedAt: new Date().toISOString(),
    foods: Object.fromEntries(
      [...out].map(([slug, e]) => [
        slug,
        { display: e.display, tags: e.tags, ...(e.img ? { img: 1 } : {}) },
      ])
    ),
    synonyms: synIndex,
  };

  const json = JSON.stringify(dict);
  await writeFile(OUT_FILE, json);
  const tagged = [...out.values()].filter((e) => e.tags.length).length;
  console.log(
    `\nWrote server/food-dict.json — ${out.size} foods, ` +
      `${Object.keys(synIndex).length} synonyms, ${tagged} tagged, ` +
      `${(json.length / 1024).toFixed(0)} KB` +
      (failed ? ` (${failed} foods had no model data)` : "")
  );
}

main().catch((e) => {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
});
