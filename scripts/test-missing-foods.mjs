// Verify coverage-gap telemetry: reasons, aggregation, and that the /foods 404 path
// ignores variant guesses (only real canonical foods count).
//   node scripts/test-missing-foods.mjs
import { getStore } from "../server/store.js";
import { annotateIngredients, lookupSlug } from "../server/foodDict.js";

const store = await getStore();
let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
};

// --- recognition-time reporting ---
const gaps = [];
await annotateIngredients(
  [
    { name: "Tomato", confidence: "confident" }, // known + illustrated -> no gap
    { name: "Definitely Not A Real Food", confidence: "confident" }, // unknown
    { name: "Neohesperidin", confidence: "maybe" }, // in dict, never illustrated
  ],
  (slug, reason) => gaps.push({ slug, reason })
);
console.log("gaps reported:", JSON.stringify(gaps));
check(
  !gaps.some((g) => g.slug === "tomato"),
  "an illustrated food reports no gap"
);
check(
  gaps.some((g) => g.slug === "definitely-not-a-real-food" && g.reason === "unknown"),
  "a food outside the dictionary is reported as 'unknown'"
);
check(
  gaps.some((g) => g.slug === "neohesperidin" && g.reason === "no_image"),
  "a known food with no illustration is reported as 'no_image'"
);

// --- the /foods 404 filter: canonical foods count, variant guesses don't ---
check((await lookupSlug("tomato")) !== null, "lookupSlug finds a canonical food");
check((await lookupSlug("tomatoe")) === null, "lookupSlug rejects a misspelled variant guess");
check((await lookupSlug("roma-tomatoes")) === null, "lookupSlug rejects a qualifier variant");

// --- store aggregation keeps the reason ---
await store.recordMissingFood("natto", "no_image");
await store.recordMissingFood("natto", "no_image");
await store.recordMissingFood("weird-thing", "unknown");
const list = await store.listMissingFoods(10);
console.log("stored:", JSON.stringify(list.map(({ slug, count, reason }) => ({ slug, count, reason }))));
check(list[0].slug === "natto" && list[0].count === 2, "counts aggregate and sort by frequency");
check(
  list.find((r) => r.slug === "weird-thing")?.reason === "unknown",
  "reason is persisted per food"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
