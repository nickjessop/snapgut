import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";

/**
 * The build id shown in Settings and attached to every metric tick, so a counter
 * cohort and a bug report are both attributable to a specific deploy.
 *
 * Derived from `package.json` plus the build timestamp rather than from a git SHA,
 * because `.git` is excluded from the Docker build context (`.dockerignore`) — a
 * `git rev-parse` would work locally and silently produce nothing in Cloud Build,
 * which is the worst of the two failure modes. The timestamp is always available
 * and always increases, which is what the field is for.
 */
const pkgVersion = JSON.parse(readFileSync("./package.json", "utf8")).version;
const buildStamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 13);
const APP_BUILD = `${pkgVersion}+${buildStamp}`;
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { appDevRoutes } from "./vite/devRoutes.js";
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { NAVIGATE_FALLBACK, navigateFallbackDenylist, precacheIgnores } from "./vite/pwa.js";

export default defineConfig({
  plugins: [
    react(),
    // Dev only: resolves `/`, `/login`, and `/app/*` to the App_Shell source, so
    // a path lands on the same document class in dev as the Origin_Server serves
    // in production (Requirement 7.5).
    appDevRoutes(),
    VitePWA({
      // "prompt" rather than "autoUpdate", and *not* to show a prompt.
      //
      // Under "autoUpdate" the generated worker calls skipWaiting/clientsClaim on
      // its own and the virtual module reloads the page the instant it takes
      // control. That reload cannot be timed, and a captured photo is an in-memory
      // Blob: an update landing mid-capture discards it (Requirement 4.8 — a load
      // can never restore an Ephemeral_Flow). Most likely right after a deploy,
      // when traffic is highest.
      //
      // "prompt" leaves the new worker waiting until the page asks for it, which is
      // the control that was missing. Updates stay invisible — `src/swUpdate.ts`
      // applies them automatically, with no toast and no approval — but it waits
      // for a moment when nothing unsaved is open.
      registerType: "prompt",
      // The plugin's own injection is document-blind: it would add
      // <script src="/registerSW.js"> to every HTML input, so the standalone
      // 404 document would register the Service_Worker and pull in a script from
      // the app's output (Requirements 7.7, 11.3). Registration lives in
      // src/swUpdate.ts, called from src/main.tsx — the App_Shell is the only
      // document that loads the app bundle, so it is the only one that starts
      // the worker.
      injectRegister: null,
      includeAssets: [
        "favicon.svg",
        "favicon.ico",
        "favicon-32.png",
        "favicon-96.png",
        "apple-touch-icon.png",
        // The badge the splash and the sign-in screen draw (src/AppIcon.tsx).
        // Named here because Workbox's default globPatterns cover png/svg/ico but
        // not webp, and 10 KB in the precache is what makes a first run offline
        // show the icon rather than the bare gradient placeholder under it.
        "app-icon-384.webp",
      ],
      manifest: {
        name: "SnapGut",
        short_name: "SnapGut",
        description: "Snap your meals, spot your triggers, feel better.",
        theme_color: "#111111",
        // Deep basil, a shade under the icon's own gradient tile (#3da57b ->
        // #2f7d5f). Android draws the masked icon on this field, so the launch
        // splash reads as the badge on brand green rather than on black — and it
        // is the same colour as the #boot screen in app/index.html, so the
        // handover between the two is seamless.
        background_color: "#2d5d4d",
        display: "standalone",
        orientation: "portrait",
        // Left at "/app" rather than moved to "/": both open the app now, and
        // "/app" is the canonical spelling the client router settles on, so an
        // install launches straight at it with no in-place URL correction
        // (Requirement 6.1). Scope stays "/" so the Login_Route and the origin
        // root are inside the installed app — scoping to "/app" would send a
        // signed-out install's sign-in screen to a browser tab (Requirement 6.2).
        start_url: "/app",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            // Padded into the centre 80% so Android's adaptive masks can crop
            // 10% off each edge without clipping the mark. The padding continues
            // the tile's own gradient (scripts/gen-icons.mjs), so the inset seam
            // is invisible.
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Both sets come from vite/pwa.js: the food pack and the 404 document
        // stay out of the Precache_Manifest, and a Navigation_Request for an API
        // path or an asset is left to the Origin_Server (Requirements 5.2, 5.3,
        // 5.6).
        globIgnores: precacheIgnores(),
        // The App_Shell answers a navigation the precache has no document for,
        // which is what makes `/` and every App_Route work offline
        // (Requirements 5.1, 5.5).
        navigateFallback: NAVIGATE_FALLBACK,
        navigateFallbackDenylist: navigateFallbackDenylist(),
        // Drops entries a previously installed worker precached and this one no
        // longer names — the flattened marketing documents above all
        // (Requirement 5.7).
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Our own illustration pack: cache each thumbnail the first time it's
            // actually shown, so only the foods a user logs are stored offline.
            urlPattern: ({ url }) => url.pathname.startsWith("/foods/"),
            handler: "CacheFirst",
            options: {
              cacheName: "food-pack",
              expiration: {
                maxEntries: 1200,
                maxAgeSeconds: 60 * 60 * 24 * 180, // 180 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  // Replaced at build time, so the running client can name its own build. Declared
  // in `src/vite-env.d.ts`.
  define: {
    __APP_BUILD__: JSON.stringify(APP_BUILD),
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      // The two documents the build emits, listed rather than derived: the
      // App_Shell, which the Origin_Server answers `/`, `/login`, `/app`, and
      // `/app/*` with (Vite still resolves /src/main.tsx from the project root,
      // so keeping the shell in `app/` costs the entry nothing), and the
      // standalone not-found document that the terminal 404 handler reads.
      input: { app: "app/index.html", notFound: "404.html" },
    },
  },
});
