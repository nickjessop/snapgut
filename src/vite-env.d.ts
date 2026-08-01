/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Google OAuth 2.0 Client ID enabling the Google Sheets integration. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

/**
 * The build id, substituted by the `define` in `vite.config.ts`. A literal at
 * runtime, so reading it costs nothing and it cannot drift from the bundle it
 * describes. Tests run through Vitest, which applies the same `define`.
 */
declare const __APP_BUILD__: string;
