// Remembers which ingredient images TheMealDB doesn't have, so we render the
// letter-avatar immediately instead of re-requesting a known 404 every session.
// (Successful images are cached by the service worker; see vite.config.ts.)

const KEY = "food-img-missing";
let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    cache = new Set<string>(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    cache = new Set<string>();
  }
  return cache;
}

export function isMissing(slug: string): boolean {
  return load().has(slug);
}

export function markMissing(slug: string): void {
  const s = load();
  if (s.has(slug)) return;
  s.add(slug);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
