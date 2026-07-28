// Theme controller. Users pick Light, Dark, or Auto (follow system).
// The resolved theme is written to <html data-theme="…"> which flips the CSS
// custom-property blocks in styles.css. Preference persists in localStorage.

export type ThemePref = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

const KEY = "snapgut-theme";
const THEME_COLOR = { light: "#fffbea", dark: "#0f1a16" } as const;

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "auto" ? v : "auto";
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveTheme(pref: ThemePref = getThemePref()): ResolvedTheme {
  return pref === "auto" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

/** Apply the resolved theme to <html> and sync the browser UI color. */
export function applyTheme(pref: ThemePref = getThemePref()): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[resolved]);
  return resolved;
}

export function setThemePref(pref: ThemePref): ResolvedTheme {
  localStorage.setItem(KEY, pref);
  return applyTheme(pref);
}

/** Call once at startup: apply the stored theme and keep Auto in sync with the OS. */
export function initTheme(): void {
  applyTheme();
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (getThemePref() === "auto") applyTheme("auto");
    });
}
