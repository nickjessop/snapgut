import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  // Mirrors the `define` in vite.config.ts so `src/build.ts` reports a stable value
  // under test instead of falling back. A fixed literal, not a timestamp, so a
  // snapshot or an assertion on it cannot depend on when the suite ran.
  define: {
    __APP_BUILD__: JSON.stringify("0.0.0-test"),
  },
  resolve: {
    alias: {
      // `virtual:pwa-register` is supplied by the VitePWA plugin, which does not run
      // here, and Vite resolves dynamic imports at transform time too — so no import
      // style avoids it. Aliasing to a stub keeps `src/swUpdate.ts` a plain static
      // import and makes the update path assertable.
      "virtual:pwa-register": fileURLToPath(
        new URL("./src/test/pwaRegisterStub.ts", import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // A collected-nothing run must fail. Left at `true`, a broken `include`
    // glob would turn the CI gate green while asserting nothing at all — the
    // one failure the gate exists to catch.
    passWithNoTests: false,
    // Node >= 22 installs a broken `localStorage` global that shadows jsdom's.
    // See the file for why this is repaired here rather than with a CLI flag.
    setupFiles: ["./src/test/webStorageSetup.ts"],
    env: {
      DATASTORE_BACKEND: "memory",
    },
  },
});
