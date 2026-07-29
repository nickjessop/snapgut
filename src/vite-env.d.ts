/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Google OAuth 2.0 Client ID enabling the Google Sheets integration. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
