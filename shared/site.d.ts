/**
 * Types for `shared/site.js`, so `src/` gets the Route_Table typed without
 * turning on `allowJs`.
 */

export interface MarketingPage {
  /** Request path, e.g. `/pricing`. `/` for the home page. */
  readonly path: string;
  /** Emitted document path inside the Build_Output, e.g. `pricing.html`. */
  readonly file: string;
  readonly title: string;
  readonly description: string;
}

/** The tabs of the app shell's internal state machine. */
export type AppViewTab = "camera" | "logs" | "insights";

/** The only `Flow` value that is addressable by URL. */
export type AddressableFlow = "settings";

export interface AppView {
  /** Request path, e.g. `/app/logs`. */
  readonly path: string;
  readonly tab: AppViewTab;
  readonly flow: AddressableFlow | null;
}

export declare const MARKETING_PAGES: readonly MarketingPage[];
export declare const NOT_FOUND_FILE: string;
export declare const LOGIN_PATH: string;
export declare const APP_PREFIX: string;
export declare const RESERVED_CONTENT_PREFIX: string;
export declare const APP_VIEWS: readonly AppView[];
export declare const DEFAULT_APP_PATH: string;

/** Fixed names of the build's generated artifacts in the Build_Output root. */
export declare const GENERATED_FILES: {
  readonly robots: string;
  readonly sitemap: string;
};

export declare function marketingPaths(): string[];
export declare function isMarketingPath(p: string): boolean;
export declare function isAppPath(p: string): boolean;
export declare function indexablePaths(): string[];
