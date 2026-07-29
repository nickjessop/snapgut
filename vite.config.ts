import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "SnapGut",
        short_name: "SnapGut",
        description: "Snap your meals, spot your triggers, feel better.",
        theme_color: "#111111",
        background_color: "#111111",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // The food illustration pack is thousands of files — never precache it
        // (that would bloat the service worker install to tens of MB). It's
        // runtime-cached on demand below instead.
        globIgnores: ["**/foods/**"],
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
  },
});
