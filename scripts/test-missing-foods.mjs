// Verify the missing-food tally in the memory backend (same shape as Firestore).
//   node scripts/test-missing-foods.mjs
import { getStore } from "../server/store.js";

const store = await getStore();
for (const s of ["natto", "natto", "natto", "durian-custard", "cherry-tomatoes"]) {
  await store.recordMissingFood(s);
}
const list = await store.listMissingFoods(10);
console.log("recorded:", JSON.stringify(list.map(({ slug, count }) => ({ slug, count }))));

const ok =
  list.length === 3 &&
  list[0].slug === "natto" &&
  list[0].count === 3 &&
  typeof list[0].lastSeen === "number";
console.log(ok ? "PASS — counts aggregate and sort by frequency" : "FAIL");
process.exit(ok ? 0 : 1);
