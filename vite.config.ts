import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { marketingPartials } from "./vite/partials.js";
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { marketingBuild, marketingInputs } from "./vite/marketing.js";
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { marketingDevRoutes } from "./vite/devRoutes.js";
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { pricingPlans } from "./vite/pricing.js";
// @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
import { NAVIGATE_FALLBACK, navigateFallbackDenylist, precacheIgnores } from "./vite/pwa.js";

export default defineConfig({
  plugins: [
    react(),
    // Dev only: resolves /login, /app/*, and each Marketing_Page path to its
    // source document, so a path lands on the same document class in dev as the
    // Origin_Server serves in production (Requirement 7.5).
    marketingDevRoutes(),
    // D2: expands the marketing pages' <!--#include …--> markers and substitutes
    // their title, description, and canonical URL from the Route_Table. A no-op
    // for the App_Shell.
    marketingPartials(),
    // Renders the pricing page's plan table from the Plan_Catalog in
    // shared/plans.js, so no price is written by hand in the template and a
    // catalog change needs no copy edit (Requirements 7.6, 9.3, 9.8).
    pricingPlans(),
    // Flattens dist/marketing/*.html to the Route_Table's `file` paths and fails
    // the build on an asset a page references but the build did not emit.
    marketingBuild(),
    VitePWA({
      registerType: "autoUpdate",
      // The plugin's own injection is document-blind: it would add
      // <script src="/registerSW.js"> to every HTML input, so a Marketing_Page
      // would register the Service_Worker and pull in a script from the app's
      // output (Requirements 7.7, 11.3). Registration lives in src/main.tsx
      // instead — the App_Shell is the only document that loads the app bundle,
      // so it is the only document that starts the worker. `autoUpdate` is
      // unaffected: the generated worker still calls skipWaiting/clientsClaim
      // and the virtual module reloads the page when the new one takes over.
      injectRegister: null,
      includeAssets: [
        "favicon.svg",
        "favicon.ico",
        "favicon-32.png",
        "favicon-96.png",
        "apple-touch-icon.png",
      ],
      manifest: {
        name: "SnapGut",
        short_name: "SnapGut",
        description: "Snap your meals, spot your triggers, feel better.",
        theme_color: "#111111",
        // The basil tile the icons sit on, so Android's launch splash reads as
        // one field of green behind the mark instead of framing it in black.
        background_color: "#2d5d4d",
        display: "standalone",
        orientation: "portrait",
        // A launch from the home screen opens the app, not the landing page
        // (Requirement 6.1). Scope stays "/" rather than "/app" so the
        // Login_Route is inside the installed app — scoping to "/app" would send
        // a signed-out install's sign-in screen to a browser tab (Requirement
        // 6.2).
        start_url: "/app",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            // Padded into the centre 80% so Android's adaptive masks can crop
            // 10% off each edge without clipping the mark. The padding is the
            // same basil green as the tile, so the inset seam is invisible.
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Both sets come from the Route_Table via vite/pwa.js: the food pack and
        // every Marketing_Site document stay out of the Precache_Manifest, and a
        // Navigation_Request for a Marketing_Page or an API path is left to the
        // Origin_Server (Requirements 5.2, 5.3, 5.6).
        globIgnores: precacheIgnores(),
        // The App_Shell answers a navigation the precache has no document for,
        // which is what makes an App_Route work offline (Requirements 5.1, 5.5).
        navigateFallback: NAVIGATE_FALLBACK,
        navigateFallbackDenylist: navigateFallbackDenylist(),
        // A worker built before the split precached the document for "/"; this
        // drops that entry when the new worker activates (Requirement 5.7).
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
          {
            // Legacy TheMealDB thumbnails — only reachable when the dev-only
            // VITE_MEALDB_FALLBACK flag is on (see src/foodImages.ts).
            urlPattern: /^https:\/\/www\.themealdb\.com\/images\/ingredients\//,
            handler: "CacheFirst",
            options: {
              cacheName: "food-images",
              expiration: {
                maxEntries: 600,
                maxAgeSeconds: 60 * 60 * 24 * 60, // 60 days
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
  build: {
    outDir: "dist",
    rollupOptions: {
      // One input per document: the App_Shell at app/index.html (so the
      // marketing site can own the project root — Vite still resolves
      // /src/main.tsx from the root, so the entry itself is unaffected), plus
      // one Marketing_Page per Route_Table entry and the not-found document.
      // Derived rather than listed, so adding a page is one Route_Table entry.
      input: marketingInputs(),
    },
  },
});
