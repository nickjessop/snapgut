/**
 * Types for `shared/site.js`, so `src/` gets the Route_Table typed without
 * turning on `allowJs`.
 */

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

export declare const NOT_FOUND_FILE: string;
export declare const LOGIN_PATH: string;
export declare const APP_PREFIX: string;
export declare const ROOT_PATH: string;
export declare const APP_VIEWS: readonly AppView[];
export declare const DEFAULT_APP_PATH: string;

export declare function isAppPath(p: string): boolean;
