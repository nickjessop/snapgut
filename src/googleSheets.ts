// Google Sheets integration (one-way mirror: app → Sheet, with optional re-import).
//
// This module is config-gated behind the `VITE_GOOGLE_CLIENT_ID` build-time
// environment variable: until that variable holds a non-whitespace value the whole
// integration reports "disabled" and the UI hides its controls (Req 1).
//
// It is intentionally split into a **pure core** (config gate, row mapping, upsert
// planning) and an **I/O shell** (GIS auth, Sheets/Drive REST, persistence, status
// store). This file currently defines the public surface and the pure config gate;
// the remaining pieces are filled in by later tasks.

import { getEvents, putEvent } from "./db";
import type {
  DraftEvent,
  LoggedSymptom,
  Ingredient,
  MealEvent,
  SymptomEvent,
  BowelEvent,
  CheckinEvent,
  StressLevel,
  SleepQuality,
} from "./db";
import { getSymptom, SYMPTOMS } from "./symptoms";
import type { Severity } from "./symptoms";
import { createSingleFlight } from "./singleFlight";
import { fetchWithTimeout } from "./httpTimeout";
// The shared owner of destination enabled state, the Pro gate, and the sync
// outcome history (cloud-sync Req 3, 14, 15). `syncSettings.ts` deliberately reads
// the spreadsheet-id key by name rather than importing this module, so this
// direction of the dependency is the only one and there is no cycle.
import {
  isDestinationEnabled,
  isProEntitled,
  recordSyncOutcome,
  setDestinationEnabled,
} from "./syncSettings";

/**
 * A spreadsheet row carries no Revision_Time, so the row mapping and the upsert
 * planner work over `DraftEvent` — a `LogEvent` without `updatedAt`. A real
 * `LogEvent` is assignable to it, so callers holding stored events are
 * unaffected, and `putEvent` is what assigns the Revision_Time on the way in.
 */
type SheetEvent = DraftEvent;

// ---- Public status model (Req 6) ----

export type SyncStatus =
  | { state: "disabled" } // Client ID not configured
  | { state: "disconnected" } // enabled, no spreadsheet id
  | { state: "connected"; lastSyncAt: number | null } // connected, may not have synced yet
  | { state: "syncing"; lastSyncAt: number | null }
  | { state: "synced"; lastSyncAt: number }
  | { state: "error"; lastSyncAt: number | null; message: string };

// ---- Sheet schema constants ----

/** Spreadsheet title, created once in the user's Drive (Req 2.2). */
export const SPREADSHEET_TITLE = "Food Snap Data";

/** Tab/sheet title within the spreadsheet. */
export const SHEET_TITLE = "Log";

/**
 * Header row written on spreadsheet creation (Req 2.3).
 *
 * This is the exact `CSV_Columns` order produced by `toCSV` in `db.ts`
 * (datetime … note) with an `id` column appended so rows are individually
 * addressable for upsert-by-id (Req 4.1) and re-import (Req 9.1).
 */
export const SHEET_HEADER = [
  "datetime",
  "type",
  "dish",
  "confident_ingredients",
  "maybe_ingredients",
  "symptoms",
  "bristol",
  "stress",
  "sleep",
  "note",
  "id",
] as const;

// ---- Config gate (Req 1) ----

/**
 * Whitespace-aware Client ID check: true iff the value contains at least one
 * non-whitespace character (equivalently `value.trim().length > 0`).
 *
 * Exported for tests (Property 1).
 */
export function isNonEmptyClientId(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) > 0;
}

/**
 * Whether the integration is configured. Reads `VITE_GOOGLE_CLIENT_ID` once
 * through {@link isNonEmptyClientId}. When false, all UI controls are hidden and
 * the integration reports a not-connected state (Req 1.1–1.4, 2.3 gating).
 */
export function isSheetsEnabled(): boolean {
  return isNonEmptyClientId(import.meta.env.VITE_GOOGLE_CLIENT_ID);
}

// ---- Local persistence (localStorage) ----
//
// Two keys back the integration's durable state (design "Local persistence"):
//   - `food-snap-sheets-spreadsheet-id` — the Spreadsheet_Id; its PRESENCE defines
//     Connected_State (Req 2.4, 7.2).
//   - `food-snap-sheets-last-sync` — epoch ms of the most recent successful sync
//     (Req 4.6, 6.1, 10.5).
//
// Access is guarded so it never throws in non-DOM contexts (e.g. SSR / workers):
// reads return `null` on failure and writes are best-effort no-ops.

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";

/** Whether a usable `localStorage` is present (guards non-DOM contexts). */
function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** Read the stored Spreadsheet_Id, or `null` when absent/empty/unavailable. */
export function getSpreadsheetId(): string | null {
  if (!hasLocalStorage()) return null;
  try {
    const v = localStorage.getItem(SPREADSHEET_ID_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Store the Spreadsheet_Id (entering Connected_State) and notify subscribers.
 * Exported for the connection lifecycle (task 11) and tests (task 8.2).
 */
export function setSpreadsheetId(id: string): void {
  if (hasLocalStorage()) {
    try {
      localStorage.setItem(SPREADSHEET_ID_KEY, id);
    } catch {
      /* best-effort — non-fatal */
    }
  }
  notify();
}

/**
 * Clear the stored Spreadsheet_Id (leaving Connected_State) and notify
 * subscribers. Exported for disconnect (task 11) and tests (task 8.2).
 */
export function clearSpreadsheetId(): void {
  if (hasLocalStorage()) {
    try {
      localStorage.removeItem(SPREADSHEET_ID_KEY);
    } catch {
      /* best-effort — non-fatal */
    }
  }
  notify();
}

/** Read the last successful sync timestamp (epoch ms), or `null` when absent. */
export function getLastSyncAt(): number | null {
  if (!hasLocalStorage()) return null;
  try {
    const v = localStorage.getItem(LAST_SYNC_KEY);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Record a successful-sync completion timestamp and notify subscribers.
 * Exported for `syncAll` (task 12.1) and tests (task 8.2).
 */
export function setLastSyncAt(ms: number): void {
  if (hasLocalStorage()) {
    try {
      localStorage.setItem(LAST_SYNC_KEY, String(ms));
    } catch {
      /* best-effort — non-fatal */
    }
  }
  notify();
}

// ---- Connection state (Req 1.3, 2, 7) ----

/**
 * Whether the Sheets destination is **active**: all four conditions of
 * cloud-sync Req 15.2 hold —
 *
 *   1. the Client ID is configured (`VITE_GOOGLE_CLIENT_ID`, Req 1.3),
 *   2. the shared enabled flag for `"sheets"` is on (cloud-sync Req 15.5 — the
 *      enabled state is owned by `syncSettings`, never by this module's own
 *      connection state),
 *   3. Pro_Entitlement is true (cloud-sync Req 15.1, 15.4), and
 *   4. a non-empty Spreadsheet_Id is stored locally (Req 2.4, 7.2).
 *
 * Every sync trigger goes through this gate, so a Pro lapse stops Sheets syncs
 * on the next trigger — `isProEntitled()` reads the in-memory entitlement
 * snapshot that `applyEntitlement` updates synchronously, well inside the 1
 * second of cloud-sync Req 15.4. Nothing here clears the stored Spreadsheet_Id,
 * revokes the Google grant, or touches the spreadsheet, so a lapse is fully
 * reversible: when Pro returns the same spreadsheet is reused and no second one
 * is created (cloud-sync Req 15.9).
 *
 * The continuous-failure half of Req 15.2 (the 72-hour rule of Req 14.9) governs
 * Backup_Reminder suppression only; it lives in `syncSettings.isDestinationActive`
 * and deliberately does not stop syncing here — a failing destination must keep
 * retrying.
 */
export function isSheetsConnected(): boolean {
  return (
    isSheetsEnabled() &&
    isDestinationEnabled("sheets") &&
    isProEntitled() &&
    getSpreadsheetId() !== null
  );
}

// ---- Runtime status store (Req 6) ----
//
// Persistence (spreadsheet id + last-sync) is combined with an in-memory runtime
// descriptor to derive the `SyncStatus` union in `getStatus()`. The runtime
// descriptor tracks the transient phase driven by the sync lifecycle (task 12):
//   - "idle"    — no sync running; derive synced/connected from last-sync.
//   - "syncing" — a sync is in flight (Req 6.2).
//   - "error"   — the most recent sync failed (Req 6.3), with an optional message.

/** In-memory runtime state; combined with persistence in {@link getStatus}. */
type RuntimeState = { phase: "idle" | "syncing" | "error"; message?: string };

let runtime: RuntimeState = { phase: "idle" };

/** Subscribers notified with the derived {@link SyncStatus} on any change. */
const listeners = new Set<(s: SyncStatus) => void>();

/**
 * Update the in-memory runtime descriptor and notify subscribers. Exported for
 * the sync lifecycle (task 12) to drive syncing/error/idle transitions; the
 * persistence setters above already notify on connect/disconnect/last-sync.
 */
export function setRuntime(next: RuntimeState): void {
  runtime = next;
  notify();
}

/** Compute the current status and push it to every subscriber. */
function notify(): void {
  const status = getStatus();
  for (const listener of listeners) listener(status);
}

// ---- Timeout wrapper (Req 2.8, 3.3, 10.1) ----

/**
 * Race `promise` against a timeout of `ms` milliseconds.
 *
 * Backed by an {@link AbortController}: when the timeout fires the controller is
 * aborted (an advisory signal for any cooperating in-flight work) and the
 * returned promise rejects with an `Error` carrying `onTimeoutMessage`. When the
 * input promise settles first the timer is cleared and its result/rejection is
 * forwarded unchanged.
 *
 * A raw `Promise<T>` cannot itself be cancelled, so the abort is advisory here:
 * the GIS token flow (below) rejects its pending callback on timeout, and the
 * REST layer (task 10.1) wires `fetch` to an abort signal where the call is made.
 * Keeping this helper a simple race keeps it reusable for both.
 *
 * @param promise           the work to bound.
 * @param ms                the timeout budget in milliseconds.
 * @param onTimeoutMessage  message for the rejection when the timeout fires.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeoutMessage = `Operation timed out after ${ms}ms`,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(onTimeoutMessage));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---- GIS token client (Req 2.1, 3.1–3.4, 7.1) ----
//
// Google Identity Services (GIS) is loaded from Google's CDN at runtime and is
// not covered by installed `@types`, so a minimal ambient shape is declared here
// and accessed through {@link gis} which narrows `globalThis.google`. Tests
// (task 9.2) drive this by assigning `(globalThis as any).google` to a mock and
// calling {@link resetGisForTests} between cases.

/** GIS token URL loaded once via {@link loadGis}. */
const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

/** Least-privileged scope: only files the app creates (Req 2.1). */
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * Refresh skew: a cached token is treated as expired this many ms before its
 * real expiry so a sync never starts with an about-to-expire token (Req 3.1).
 */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Interactive-consent timeout (Req 2.8). */
const CONSENT_TIMEOUT_MS = 60_000;

/** Silent-token (background refresh) timeout (Req 3.3). */
const SILENT_TOKEN_TIMEOUT_MS = 30_000;

/** Token payload delivered to the token client's `callback`. */
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** The token client returned by `initTokenClient`. */
interface GisTokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
  callback: (response: GisTokenResponse) => void;
}

/** Config accepted by `initTokenClient`. */
interface GisTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GisTokenResponse) => void;
}

/** The `google.accounts.oauth2` surface this module depends on. */
interface GisOAuth2 {
  initTokenClient(config: GisTokenClientConfig): GisTokenClient;
  revoke(token: string, done?: () => void): void;
}

/** The `google` global shape this module depends on. */
interface GisGoogle {
  accounts: { oauth2: GisOAuth2 };
}

/** In-memory (never persisted) access token with its absolute expiry (Req 3.1). */
interface CachedToken {
  token: string;
  expiresAt: number;
}

let gisScriptPromise: Promise<void> | null = null;
let tokenClient: GisTokenClient | null = null;
let cachedToken: CachedToken | null = null;

/**
 * Narrowing accessor for the GIS `oauth2` surface. Throws when GIS is not
 * available (script not loaded / not in a browser), so callers should
 * `await loadGis()` first.
 */
function gis(): GisOAuth2 {
  const g = (globalThis as unknown as { google?: GisGoogle }).google;
  if (!g?.accounts?.oauth2) {
    throw new Error("Google Identity Services is not available");
  }
  return g.accounts.oauth2;
}

/** Whether the GIS `oauth2` surface is currently present on the global. */
function gisAvailable(): boolean {
  return Boolean((globalThis as unknown as { google?: GisGoogle }).google?.accounts?.oauth2);
}

/**
 * Load the GIS client script exactly once (Req 2.1 groundwork).
 *
 * The load is memoized in a module-level singleton promise so repeated calls
 * reuse the same in-flight (or resolved) load rather than injecting the script
 * again. If GIS is already present on the global (e.g. injected by a prior load
 * or a test mock) this resolves immediately. A failed load clears the singleton
 * so a later call can retry.
 */
export async function loadGis(): Promise<void> {
  if (gisAvailable()) return;
  if (gisScriptPromise) return gisScriptPromise;

  gisScriptPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      gisScriptPromise = null;
      reject(new Error("Cannot load Google Identity Services outside a DOM environment"));
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SCRIPT_URL}"]`,
    );
    if (existing) {
      if (gisAvailable()) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => {
        gisScriptPromise = null;
        reject(new Error("Failed to load Google Identity Services"));
      });
      return;
    }

    const script = document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisScriptPromise = null;
      reject(new Error("Failed to load Google Identity Services"));
    };
    document.head.appendChild(script);
  });

  return gisScriptPromise;
}

/**
 * Lazily create (and memoize) the GIS token client bound to the configured
 * Client ID and the {@link DRIVE_FILE_SCOPE} (Req 2.1). The per-request
 * `callback` is (re)assigned by {@link getAccessToken} before each
 * `requestAccessToken` call; the init callback here is a placeholder.
 */
function getTokenClient(): GisTokenClient {
  if (tokenClient) return tokenClient;
  tokenClient = gis().initTokenClient({
    client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
    scope: DRIVE_FILE_SCOPE,
    callback: () => {
      /* replaced per-request by getAccessToken */
    },
  });
  return tokenClient;
}

/**
 * Acquire an access token (Req 2.1, 3.1–3.3).
 *
 * - `interactive: true` → show the consent/account-chooser prompt
 *   (`prompt: 'consent'`) with a 60s timeout (Req 2.8). Used by connect.
 * - `interactive: false` → reuse the in-memory cached token while it is still
 *   valid (`Date.now() < expiresAt - SKEW`, Req 3.1); otherwise request a fresh
 *   token silently (`prompt: ''`) with a 30s timeout (Req 3.2, 3.3).
 *
 * On a fresh grant the token is cached in memory (never persisted) with
 * `expiresAt = Date.now() + expires_in * 1000`. Rejects on an error response
 * (user denied / GIS error) or on timeout; the caller (task 11/12) maps that to
 * a not-connected/error state and, for silent failures, a reconnect prompt
 * (Req 3.4).
 */
export async function getAccessToken(interactive: boolean): Promise<string> {
  if (
    !interactive &&
    cachedToken &&
    Date.now() < cachedToken.expiresAt - TOKEN_EXPIRY_SKEW_MS
  ) {
    return cachedToken.token;
  }

  await loadGis();
  const client = getTokenClient();

  const acquire = new Promise<string>((resolve, reject) => {
    client.callback = (response: GisTokenResponse) => {
      if (response.error || !response.access_token) {
        reject(
          new Error(
            response.error_description ||
              response.error ||
              "Failed to obtain a Google access token",
          ),
        );
        return;
      }
      cachedToken = {
        token: response.access_token,
        expiresAt: Date.now() + (response.expires_in ?? 0) * 1000,
      };
      resolve(response.access_token);
    };

    try {
      client.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return withTimeout(
    acquire,
    interactive ? CONSENT_TIMEOUT_MS : SILENT_TOKEN_TIMEOUT_MS,
    interactive
      ? "Google authorization timed out"
      : "Google token refresh timed out",
  );
}

/**
 * Revoke the in-memory access token (if any) and clear it (Req 7.1).
 *
 * The cached token is cleared unconditionally (so `Connected_State` token reuse
 * stops immediately) before awaiting the remote revoke. Resolves once GIS
 * invokes its revoke callback; rejects if the revoke call throws. The disconnect
 * flow (task 11.1) clears local connection state regardless of this outcome
 * (Req 7.5).
 */
export async function revokeToken(): Promise<void> {
  const token = cachedToken?.token;
  resetTokenCache();
  if (!token) return;
  await new Promise<void>((resolve, reject) => {
    try {
      gis().revoke(token, () => resolve());
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Clear the in-memory access token (used by disconnect and on token errors). */
export function resetTokenCache(): void {
  cachedToken = null;
}

/**
 * Reset all GIS singletons (script-load promise, token client, cached token).
 * Exported for tests (task 9.2) so each case can install a fresh
 * `(globalThis as any).google` mock without leaking state across cases.
 */
export function resetGisForTests(): void {
  gisScriptPromise = null;
  tokenClient = null;
  cachedToken = null;
}

// ---- Google REST layer (Sheets v4 + Drive v3) — I/O shell (Req 2.2, 2.3, 4.2, 4.3, 7.6, 7.7) ----
//
// Every call attaches `Authorization: Bearer <token>` (the token is supplied by
// the caller via `getAccessToken`) and is bounded by {@link fetchWithTimeout} using
// the {@link API_TIMEOUT_MS} budget (Req 10.1). Non-2xx responses throw a
// descriptive `Error` (including the HTTP status) so the sync/connect layers
// (tasks 11/12) can surface an error status and leave local data untouched.
//
// Range math (used by {@link batchUpdateRows}): the header occupies sheet row 1,
// so the data row for `existingIds` index `i` is sheet row `i + 2`. Its A1 range
// is therefore `${SHEET_TITLE}!A${i + 2}` — writing starting at column A lets the
// Sheets API spread the row's cells across the following columns.

/** Base URL for the Sheets v4 spreadsheets resource. */
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** Base URL for the Drive v3 files resource (existence/trashed checks). */
const DRIVE_FILES_API_BASE = "https://www.googleapis.com/drive/v3/files";

/**
 * Per-request timeout budget for every Google REST call (Req 10.1). A request
 * that neither resolves nor rejects within this window is aborted and treated as
 * a failure by {@link fetchWithTimeout}.
 */
export const API_TIMEOUT_MS = 30_000;

/**
 * Shared fetch helper for the Sheets/Drive REST calls.
 *
 * Attaches `Authorization: Bearer <token>`, adds `Content-Type: application/json`
 * whenever a request body is present, and bounds the fetch with
 * {@link fetchWithTimeout} (real cancellation via an `AbortController` signal).
 * Throws a descriptive `Error` (including the HTTP status) on any non-2xx
 * response.
 *
 * {@link driveFileExists} does NOT use this helper because it must distinguish a
 * 404 (file gone → `false`) from other failures (throw); it does its own fetch.
 */
async function sheetsFetch(
  token: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined && init.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetchWithTimeout(
    url,
    {
      ...init,
      headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) },
    },
    timeoutMs,
  );
  if (!res.ok) {
    throw new Error(`Google API request failed: ${res.status} ${res.statusText}`);
  }
  return res;
}

/**
 * Create the Data_Spreadsheet titled exactly {@link SPREADSHEET_TITLE} with a
 * single sheet named {@link SHEET_TITLE} (Req 2.2). Returns the new
 * `spreadsheetId` from the response.
 */
export async function createSpreadsheet(token: string): Promise<string> {
  const res = await sheetsFetch(token, SHEETS_API_BASE, {
    method: "POST",
    body: JSON.stringify({
      properties: { title: SPREADSHEET_TITLE },
      sheets: [{ properties: { title: SHEET_TITLE } }],
    }),
  });
  const data = (await res.json()) as { spreadsheetId?: string };
  if (!data.spreadsheetId) {
    throw new Error("Spreadsheet creation returned no spreadsheetId");
  }
  return data.spreadsheetId;
}

/**
 * Write the {@link SHEET_HEADER} row into `Log!A1` using RAW input (Req 2.3).
 * Called before the Spreadsheet_Id is stored so a partially-created spreadsheet
 * never enters Connected_State.
 */
export async function writeHeader(token: string, spreadsheetId: string): Promise<void> {
  const range = encodeURIComponent(`${SHEET_TITLE}!A1`);
  await sheetsFetch(
    token,
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: JSON.stringify({ values: [[...SHEET_HEADER]] }),
    },
  );
}

/**
 * Read every value in the Log sheet (header row + all data rows) as a matrix of
 * strings, returning `[]` when the sheet is empty. Used by the sync diff
 * (task 12) and re-import (task 13).
 */
export async function readAllRows(token: string, spreadsheetId: string): Promise<string[][]> {
  const range = encodeURIComponent(SHEET_TITLE);
  const res = await sheetsFetch(
    token,
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${range}`,
  );
  const data = (await res.json()) as { values?: string[][] };
  return data.values ?? [];
}

/**
 * Update existing data rows in place via a single `values:batchUpdate` (Req 4.2).
 *
 * Each entry's `rowIndex` is the 0-based index into the sheet's data rows (as
 * returned by {@link computeUpsertPlan}); it is translated to the A1 range
 * `${SHEET_TITLE}!A${rowIndex + 2}` (header is row 1, so data row `i` is sheet
 * row `i + 2`). A no-op when `updates` is empty.
 */
export async function batchUpdateRows(
  token: string,
  spreadsheetId: string,
  updates: { rowIndex: number; row: string[] }[],
): Promise<void> {
  if (updates.length === 0) return;
  const data = updates.map(({ rowIndex, row }) => ({
    range: `${SHEET_TITLE}!A${rowIndex + 2}`,
    values: [row],
  }));
  await sheetsFetch(token, `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
}

/**
 * Append new data rows below the current content of the Log sheet (Req 4.3).
 * A no-op when `rows` is empty.
 */
export async function appendRows(
  token: string,
  spreadsheetId: string,
  rows: string[][],
): Promise<void> {
  if (rows.length === 0) return;
  const range = `${encodeURIComponent(SHEET_TITLE)}:append`;
  await sheetsFetch(
    token,
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: "POST",
      body: JSON.stringify({ values: rows }),
    },
  );
}

/**
 * Whether the stored Data_Spreadsheet still exists in the user's Drive and is
 * not trashed (Req 7.6, 7.7).
 *
 * Returns `true` when Drive reports the file with `trashed !== true`, `false`
 * when the file is missing (404) or trashed. Any other non-2xx response throws
 * so a transient error is not mistaken for a missing file (which would trigger a
 * spurious re-create).
 */
export async function driveFileExists(token: string, spreadsheetId: string): Promise<boolean> {
  const url = `${DRIVE_FILES_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=id,trashed`;
  const res = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    API_TIMEOUT_MS,
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`Drive files.get failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { trashed?: boolean };
  return data.trashed !== true;
}

/**
 * Ensure a usable Data_Spreadsheet exists and return its Spreadsheet_Id
 * (Req 2.2, 2.3, 7.6, 7.7).
 *
 * - When an id is already stored AND its Drive file still exists, reuse it
 *   (Req 7.6).
 * - Otherwise (no stored id, or the stored file is missing/trashed) create a new
 *   spreadsheet, write the header, and store the id — storing ONLY AFTER the
 *   header write succeeds, so a failed create/header write never enters
 *   Connected_State (Req 2.3/2.4 ordering; Req 7.7).
 *
 * Accepts the access `token` from the caller (`connect`/`syncAll` obtain it via
 * {@link getAccessToken}).
 */
export async function ensureSpreadsheet(token: string): Promise<string> {
  const existing = getSpreadsheetId();
  if (existing !== null) {
    if (await driveFileExists(token, existing)) return existing;
    // Stored file missing/trashed → fall through and create a fresh one (Req 7.7).
  }

  const id = await createSpreadsheet(token);
  await writeHeader(token, id);
  // Store the id ONLY after the header write succeeds (Req 2.3/2.4 ordering).
  setSpreadsheetId(id);
  return id;
}

// ---- Connection lifecycle (Req 2, 7) — implemented in later tasks ----

/**
 * Connect the integration to Google Sheets (Req 2).
 *
 * Flow:
 *   1. Request an interactive consent token via GIS (`prompt: 'consent'`,
 *      Req 2.1) with a 60s timeout (Req 2.8).
 *   2. {@link ensureSpreadsheet} either reuses the stored Data_Spreadsheet
 *      (Req 2.6) or creates one, writes the header, and stores the id ONLY after
 *      the header write succeeds (Req 2.2/2.3/2.4).
 *   3. On success, reset the runtime phase to `idle` so `getStatus` derives a
 *      clean connected/synced state (Req 2.4, 6.4) and notifies subscribers.
 *
 * On any failure — user cancel/denial (Req 2.5), create/header-write failure
 * (Req 2.7), or consent timeout (Req 2.8) — no Spreadsheet_Id is stored, so the
 * integration stays not-connected (`getStatus` returns `disconnected`). The
 * runtime phase is set to `error` with a friendly message and the error is
 * rethrown so the caller (SettingsView, task 15.1) can surface a toast.
 */
export async function connect(): Promise<void> {
  let token: string;
  try {
    // Interactive consent (Req 2.1); rejects on cancel/denial (Req 2.5) or the
    // 60s timeout (Req 2.8).
    token = await getAccessToken(true);
  } catch (err) {
    // No id stored → stays not-connected (Req 2.5, 2.8).
    setRuntime({ phase: "error", message: "Connection not completed" });
    throw err instanceof Error ? err : new Error(String(err));
  }

  try {
    // Reuse (Req 2.6) or create + header-write + store id after header (Req 2.2/2.3/2.4).
    // `ensureSpreadsheet` never stores an id when create/header write fails (Req 2.7).
    await ensureSpreadsheet(token);
  } catch (err) {
    // No id stored → stays not-connected (Req 2.7).
    setRuntime({ phase: "error", message: "Couldn't create the spreadsheet" });
    throw err instanceof Error ? err : new Error(String(err));
  }

  // A completed connection is the user enabling the destination, and the enabled
  // state is owned by `syncSettings` (cloud-sync Req 15.5). Recorded only after
  // the spreadsheet exists, so a failed connect never enables anything.
  setDestinationEnabled("sheets", true);

  // Id is stored → connected (Req 2.4). Reset runtime to idle so `getStatus`
  // derives connected/synced from persistence, and notify subscribers.
  setRuntime({ phase: "idle" });
}

/**
 * Disconnect the integration from Google Sheets (Req 7).
 *
 * Order guarantees the local disconnect always happens, even when the remote
 * revoke fails (Req 7.5):
 *   1. Revoke the access token (Req 7.1); remember but do not rethrow a failure.
 *   2. Clear the Spreadsheet_Id so `Connected_State` becomes inactive (Req 7.2).
 *      The remote Data_Spreadsheet is never modified or deleted (Req 7.3).
 *   3. Reset the in-memory token cache and the runtime phase to `idle` so
 *      `getStatus` returns `disconnected` (Req 7.4 confirmation is a UI toast).
 *   4. If the revoke failed, rethrow so the UI can indicate the token could not
 *      be revoked remotely (Req 7.5) — after the local disconnect has completed.
 */
export async function disconnect(): Promise<void> {
  let revokeError: Error | null = null;
  try {
    await revokeToken(); // Req 7.1
  } catch (err) {
    // Remember the failure but STILL disconnect locally (Req 7.5).
    revokeError = err instanceof Error ? err : new Error(String(err));
  }

  clearSpreadsheetId(); // Connected_State inactive (Req 7.2); remote untouched (Req 7.3).
  setDestinationEnabled("sheets", false); // shared enabled state (cloud-sync Req 15.5)
  resetTokenCache(); // belt-and-suspenders (revokeToken already clears it).
  setRuntime({ phase: "idle" }); // reset status → getStatus returns "disconnected".

  if (revokeError) {
    throw new Error("Disconnected, but the token couldn't be revoked remotely");
  }
}

// ---- Sync (Req 4, 5, 10) ----

/** Symptom id → human label, from the real `SYMPTOMS` registry (Req 4.4). */
const labelForSymptom = (id: string): string => getSymptom(id)?.label ?? id;

/** Best-effort friendly message for an arbitrary thrown value (Req 4.9, 6.3). */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 0 ? raw : "Sync failed";
}

/**
 * The real sync body: mirror every local `LogEvent` into the Data_Spreadsheet
 * using upsert-by-id semantics (Req 4, 10).
 *
 * Flow:
 *   1. Mark the runtime `syncing` so the UI shows an in-progress status (Req 6.2).
 *   2. Offline short-circuit: when `navigator.onLine === false`, set the error
 *      status and make **no** Google API request (Req 10.2). The error is thrown
 *      so the caller can surface it exactly like any other sync failure; the
 *      single-flight guard cleans up on rejection, so a queued rerun still runs.
 *   3. Silent token (Req 3.2; rejects on error or the 30s timeout, Req 3.3), then
 *      read the current sheet, plan the upsert, and write:
 *      **updates first, then appends** — update row indexes are relative to the
 *      rows read at the start, and appends change the sheet's row count.
 *   4. Only once every in-scope event has been written with no error, record the
 *      completion timestamp (Req 4.6) and reset the runtime to `idle` so
 *      `getStatus` derives `synced` (Req 6.1) and any previous error is cleared
 *      (Req 10.3).
 *
 * Invariants on failure (Req 4.8, 10.1, 10.4, 10.5): local IndexedDB events are
 * only ever **read** here (never written), and `setLastSyncAt` is never called,
 * so the previous successful-sync timestamp stays unchanged. The error status is
 * set and the error rethrown, so it persists until a later trigger succeeds
 * (Req 4.9, 5.6, 6.3).
 */
async function syncBody(): Promise<void> {
  setRuntime({ phase: "syncing" }); // Req 6.2

  // No connectivity → error status, no API request at all (Req 10.2). Local
  // logging keeps working because nothing local is touched (Req 10.4).
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const message = "You're offline — sync will retry later";
    setRuntime({ phase: "error", message });
    // A failed attempt like any other, so the 72-hour rule sees it (cloud-sync
    // Req 14.9); `lastSuccessAt` is left untouched (cloud-sync Req 15.7).
    recordSyncOutcome("sheets", "failure", Date.now());
    throw new Error(message);
  }

  try {
    // Silent refresh; reuses the cached token until near expiry (Req 3.1, 3.2)
    // and rejects on error / 30s timeout (Req 3.3).
    const token = await getAccessToken(false);

    const spreadsheetId = getSpreadsheetId();
    if (spreadsheetId === null) {
      // `syncAll` guards on connection state, so this should be unreachable.
      throw new Error("No Google spreadsheet is connected");
    }

    // Header row + data rows; the id column (index 10) of each data row gives
    // the current sheet keys for the upsert diff.
    const all = await readAllRows(token, spreadsheetId);
    const existingIds = all.slice(1).map((r) => r[10] ?? "");

    // Read-only access to local data — never mutated by a sync (Req 4.8, 10.1).
    const events = await getEvents();

    const plan = computeUpsertPlan(existingIds, events);

    // Updates BEFORE appends: `rowIndex` values refer to the rows read above.
    await batchUpdateRows(
      token,
      spreadsheetId,
      plan.updates.map((u) => ({
        rowIndex: u.rowIndex,
        row: rowFromEvent(u.event, labelForSymptom),
      })),
    ); // Req 4.2 (no-op when empty)

    await appendRows(
      token,
      spreadsheetId,
      plan.appends.map((e) => rowFromEvent(e, labelForSymptom)),
    ); // Req 4.3 (no-op when empty)

    // Every in-scope event written with no error → record completion (Req 4.6)
    // and clear any previous error status (Req 10.3).
    const completedAt = Date.now();
    setLastSyncAt(completedAt);
    // Feed the shared 72-hour failing rule (cloud-sync Req 14.9): a success here
    // is what rescues the destination from the failing state.
    recordSyncOutcome("sheets", "success", completedAt);
    setRuntime({ phase: "idle" }); // getStatus derives "synced" (Req 6.1)
  } catch (err) {
    // Error status only — no local writes, no timestamp update (Req 4.8, 10.5).
    setRuntime({ phase: "error", message: errorMessage(err) }); // Req 4.9, 6.3, 10.1
    // Failure recorded for the 72-hour rule; the last successful sync timestamp
    // and `lastSuccessAt` both stay unchanged (cloud-sync Req 14.9, 15.7).
    recordSyncOutcome("sheets", "failure", Date.now());
    // Rethrow so the UI can toast and the error status persists until a later
    // successful trigger (Req 5.6, 10.3).
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Module-level single-flight instance shared by every sync trigger (Req 5.5). */
const triggerSync = createSingleFlight(syncBody);

/**
 * Single entry point for all sync triggers (save, app-open, "Sync now").
 *
 * When disconnected the trigger is a no-op (Req 5.4). When connected it runs the
 * sync body through the module-level single-flight guard so overlapping triggers
 * never start a concurrent sync and schedule at most one additional run (Req 5.5).
 */
export async function syncAll(): Promise<void> {
  // Disconnected → no-op (Req 5.4).
  if (!isSheetsConnected()) return;
  await triggerSync();
}

// ---- Re-import (Req 9) ----

/**
 * Inverse of {@link labelForSymptom}: human label → symptom id, built once from
 * the real `SYMPTOMS` registry (labels are unique). A label with no entry yields
 * `undefined`, which makes {@link eventFromRow} skip that row (Req 9.3).
 */
const SYMPTOM_ID_BY_LABEL = new Map(SYMPTOMS.map((s) => [s.label, s.id]));

/** Lookup used as `eventFromRow`'s `symptomIdFor` during re-import. */
const symptomIdForLabel = (label: string): string | undefined =>
  SYMPTOM_ID_BY_LABEL.get(label);

/**
 * Re-import the Data_Spreadsheet back into local IndexedDB (Req 9).
 *
 * Flow:
 *   1. Disconnected guard (Req 9.7): when `Connected_State` is inactive no
 *      re-import is initiated at all — this returns zero counts rather than
 *      throwing, so a UI that calls it while disconnected simply does nothing.
 *   2. Read the whole sheet FIRST (Req 9.1), before any local write. A token /
 *      read / network / timeout failure therefore cannot leave a partial merge:
 *      the error status is set (Req 9.6) and the error rethrown so the UI can
 *      toast it, with **zero** local events touched.
 *   3. Skip the header row and reconstruct each data row with
 *      {@link eventFromRow}; a `null` result counts as skipped and processing
 *      continues (Req 9.3).
 *   4. Merge by id via `putEvent` (an id-keyed `put`), so an existing id is
 *      updated in place and never duplicated (Req 9.2). The reconstructed event
 *      carries the sheet's non-photo values, which overwrite the local non-photo
 *      fields; when the local event is a meal with a photo, that photo is carried
 *      over onto the reconstructed meal so the local-only photo survives
 *      (Req 9.2). Local events are only ever added/updated — never deleted.
 *   5. Return the imported/skipped counts for the UI to report (Req 9.5).
 *
 * On success the runtime phase is deliberately left untouched: a re-import is not
 * a Sync_Operation, so it must not record a completion timestamp
 * (`setLastSyncAt` is never called here) or fabricate a "synced"/"syncing"
 * status that would misrepresent the sync state.
 */
export async function reimport(): Promise<{ imported: number; skipped: number }> {
  // Disconnected → do not initiate a re-import (Req 9.7).
  if (!isSheetsConnected()) return { imported: 0, skipped: 0 };

  // --- Read phase: everything that can fail happens BEFORE any local write ---
  let all: string[][];
  try {
    // Silent refresh (Req 3.2); rejects on error / 30s timeout (Req 3.3).
    const token = await getAccessToken(false);
    const spreadsheetId = getSpreadsheetId();
    if (spreadsheetId === null) {
      // Guarded above; defensive only.
      throw new Error("No Google spreadsheet is connected");
    }
    all = await readAllRows(token, spreadsheetId); // Req 9.1
  } catch (err) {
    // Error indication; no local write has happened, so all local events are
    // unchanged (Req 9.6). Rethrow so the UI can surface it.
    setRuntime({ phase: "error", message: "Couldn't read the spreadsheet" });
    throw err instanceof Error ? err : new Error(String(err));
  }

  // --- Merge phase ---
  const dataRows = all.slice(1); // skip the header row (Req 9.1)

  // Existing local events, read once, to find photos worth retaining (Req 9.2).
  const existing = await getEvents();
  const localById = new Map(existing.map((e) => [e.id, e]));

  let imported = 0;
  let skipped = 0;

  for (const row of dataRows) {
    const ev = eventFromRow(row, symptomIdForLabel);
    if (ev === null) {
      skipped++; // malformed row → skip and continue (Req 9.3)
      continue;
    }

    // Retain the existing local photo (photos are never synced to the sheet).
    const prev = localById.get(ev.id);
    let toStore: SheetEvent = ev;
    if (prev && prev.type === "meal" && ev.type === "meal" && prev.photo) {
      toStore = { ...ev, photo: prev.photo };
    }

    // `putEvent` is a `put` keyed by id → updates in place, no duplicates (Req 9.2).
    await putEvent(toStore);
    imported++;
  }

  return { imported, skipped }; // counts reported by the UI (Req 9.5)
}

// ---- Status store (Req 6) ----

/**
 * Derive the current {@link SyncStatus} from the config gate, persistence
 * (spreadsheet id + last-sync), and the in-memory runtime phase (Req 6.1–6.4):
 *
 * - not enabled → `disabled`.
 * - enabled but no spreadsheet id → `disconnected`.
 * - connected:
 *   - runtime `syncing` → `syncing` (Req 6.2).
 *   - runtime `error` → `error` with the last message (Req 6.3).
 *   - runtime `idle`:
 *     - a successful sync recorded → `synced` with its timestamp (Req 6.1).
 *     - none yet → `connected` with `lastSyncAt: null` (Req 6.4).
 */
export function getStatus(): SyncStatus {
  if (!isSheetsEnabled()) return { state: "disabled" };
  if (getSpreadsheetId() === null) return { state: "disconnected" };

  const lastSyncAt = getLastSyncAt();

  if (runtime.phase === "syncing") return { state: "syncing", lastSyncAt };
  if (runtime.phase === "error") {
    return { state: "error", lastSyncAt, message: runtime.message ?? "Sync failed" };
  }

  // runtime.phase === "idle"
  if (lastSyncAt !== null) return { state: "synced", lastSyncAt };
  return { state: "connected", lastSyncAt: null };
}

/**
 * Subscribe to status changes. The listener is invoked with the derived
 * {@link SyncStatus} whenever the runtime phase or persisted connection/last-sync
 * state changes. Returns an unsubscribe function that removes the listener.
 */
export function subscribe(listener: (s: SyncStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- Backup-nudge gate (Req 8) — moved to `syncSettings.ts` ----
//
// `shouldNudgeBackup(connected, backupDue)` and its `isBackupNudgeDue` wrapper
// used to live here, gating the reminder on this module's connection state alone.
// Both are retired: cloud-sync Req 15.6 derives suppression from the shared
// N-destination predicate, so `syncSettings.shouldNudgeBackup(destinations,
// backupDue)` and `syncSettings.isBackupNudgeDue(hasData)` are now the only gate,
// and Req 8 is satisfied through it (the Sheets destination being active is one
// of the ways suppression turns on).

// ---- Pure core: row mapping & upsert planning (exported for tests) ----
// These are implemented in tasks 3 and 4; declared here so the module's public
// surface is complete and type-correct.

export function rowFromEvent(e: SheetEvent, labelFor: (id: string) => string): string[] {
  // Mirrors the exact per-cell field mapping of `toCSV` in `db.ts` for the first
  // ten cells (raw, unescaped values — the Sheets API takes raw cell values),
  // then appends `e.id` as the eleventh cell (Req 4.4). Photos/Blobs are never
  // included in any cell (Req 4.5).
  const symptomsText = (syms?: LoggedSymptom[]) =>
    (syms ?? []).map((s) => `${labelFor(s.id)} (${s.severity})`).join("; ");

  const dt = new Date(e.createdAt).toISOString();
  let dish = "";
  let confident = "";
  let maybe = "";
  let symptoms = "";
  let bristol = "";
  let stress = "";
  let sleep = "";

  if (e.type === "meal") {
    dish = e.dish;
    confident = e.ingredients
      .filter((i) => i.confidence === "confident")
      .map((i) => i.name)
      .join("; ");
    maybe = e.ingredients
      .filter((i) => i.confidence === "maybe")
      .map((i) => i.name)
      .join("; ");
  } else if (e.type === "symptom") {
    symptoms = symptomsText(e.symptoms);
  } else if (e.type === "bowel") {
    bristol = String(e.bristol);
    symptoms = symptomsText(e.symptoms);
  } else if (e.type === "checkin") {
    stress = e.stress ?? "";
    sleep = e.sleep ?? "";
  }

  return [dt, e.type, dish, confident, maybe, symptoms, bristol, stress, sleep, e.note ?? "", e.id];
}

/** Event types that a valid row may reconstruct. */
const KNOWN_TYPES = new Set(["meal", "symptom", "bowel", "checkin"]);

/** `label (severity)` token, capturing the label and a valid severity. */
const SYMPTOM_TOKEN = /^(.*) \((mild|moderate|severe)\)$/;

/**
 * Split a `"; "`-joined list cell into non-empty trimmed-of-nothing tokens.
 *
 * Splitting the empty string on `"; "` yields `[""]`, which would otherwise
 * produce spurious empty entries — those are filtered out here.
 */
function splitList(cell: string | undefined): string[] {
  return (cell ?? "").split("; ").filter((s) => s.length > 0);
}

/**
 * Parse a symptoms cell (`"label (severity); …"`) back into `LoggedSymptom`s.
 *
 * Returns `null` when any token is malformed: a token that does not match the
 * `label (severity)` shape (which also enforces `severity ∈ mild|moderate|severe`),
 * or a label with no matching id via `symptomIdFor`. An empty cell yields `[]`.
 */
function parseSymptoms(
  cell: string | undefined,
  symptomIdFor: (label: string) => string | undefined,
): LoggedSymptom[] | null {
  const tokens = splitList(cell);
  const result: LoggedSymptom[] = [];
  for (const token of tokens) {
    const match = SYMPTOM_TOKEN.exec(token);
    if (!match) return null;
    const label = match[1];
    const severity = match[2] as Severity;
    const id = symptomIdFor(label);
    if (id === undefined) return null;
    result.push({ id, severity });
  }
  return result;
}

/**
 * Inverse of {@link rowFromEvent}: reconstruct a `LogEvent` from a sheet row.
 *
 * The row layout is the {@link SHEET_HEADER} order:
 * `[datetime, type, dish, confident_ingredients, maybe_ingredients, symptoms,
 *   bristol, stress, sleep, note, id]`.
 *
 * Returns `null` (row skipped, Req 9.3) — and never throws (Property 6) — when:
 * the id is missing/empty, the `type` is unknown, the `datetime` is unparseable,
 * the `bristol` is non-numeric for a bowel row, a `severity` token is out of set,
 * or a symptom label has no matching id.
 */
export function eventFromRow(
  row: string[],
  symptomIdFor: (label: string) => string | undefined,
): SheetEvent | null {
  try {
    const id = (row[10] ?? "").trim();
    if (id.length === 0) return null;

    const type = row[1];
    if (!KNOWN_TYPES.has(type)) return null;

    const createdAt = new Date(row[0]).getTime();
    if (Number.isNaN(createdAt)) return null;

    const note = row[9] || undefined;
    const base = { id, createdAt, ...(note !== undefined ? { note } : {}) };

    if (type === "meal") {
      const confident: Ingredient[] = splitList(row[3]).map((name) => ({
        name,
        confidence: "confident",
      }));
      const maybe: Ingredient[] = splitList(row[4]).map((name) => ({
        name,
        confidence: "maybe",
      }));
      const event: Omit<MealEvent, "updatedAt"> = {
        ...base,
        type: "meal",
        dish: row[2] ?? "",
        ingredients: [...confident, ...maybe],
      };
      return event;
    }

    if (type === "symptom") {
      const symptoms = parseSymptoms(row[5], symptomIdFor);
      if (symptoms === null) return null;
      const event: Omit<SymptomEvent, "updatedAt"> = { ...base, type: "symptom", symptoms };
      return event;
    }

    if (type === "bowel") {
      const bristolCell = (row[6] ?? "").trim();
      if (bristolCell.length === 0) return null;
      const bristol = Number(bristolCell);
      if (Number.isNaN(bristol)) return null;
      const symptoms = parseSymptoms(row[5], symptomIdFor);
      if (symptoms === null) return null;
      const event: Omit<BowelEvent, "updatedAt"> = {
        ...base,
        type: "bowel",
        bristol,
        ...(symptoms.length > 0 ? { symptoms } : {}),
      };
      return event;
    }

    // type === "checkin"
    const stress = (row[7] || undefined) as StressLevel | undefined;
    const sleep = (row[8] || undefined) as SleepQuality | undefined;
    const event: Omit<CheckinEvent, "updatedAt"> = {
      ...base,
      type: "checkin",
      ...(stress !== undefined ? { stress } : {}),
      ...(sleep !== undefined ? { sleep } : {}),
    };
    return event;
  } catch {
    // Never throw on malformed input — skip the row instead (Req 9.3, Property 6).
    return null;
  }
}

/**
 * Decide, for a set of events, which map to an **update** of an existing sheet
 * row and which map to a new **append**, keyed by event id (Req 4.1–4.3).
 *
 * `existingIds` is the id column of the current sheet's data rows in row order
 * (index 0 = first data row). The returned `rowIndex` is the 0-based index into
 * that array; mapping to a concrete A1 range is the I/O layer's job.
 *
 * Guarantees each distinct id is represented by exactly one row (Property 2):
 * - If the sheet contains duplicate ids, the first occurrence's row wins.
 * - If `events` contains multiple events with the same id, they are deduplicated
 *   to a single entry with the **last** occurrence's payload winning (most recent
 *   state), preserving first-seen ordering for determinism.
 */
export function computeUpsertPlan(
  existingIds: string[], // id column of current sheet rows, in row order
  events: SheetEvent[],
): { updates: { rowIndex: number; event: SheetEvent }[]; appends: SheetEvent[] } {
  // id → existing row index (first occurrence wins if the sheet has duplicates).
  const rowById = new Map<string, number>();
  existingIds.forEach((id, rowIndex) => {
    if (!rowById.has(id)) rowById.set(id, rowIndex);
  });

  // Deduplicate events by id: keep first-seen ordering, last payload wins.
  const order: string[] = [];
  const eventById = new Map<string, SheetEvent>();
  for (const event of events) {
    if (!eventById.has(event.id)) order.push(event.id);
    eventById.set(event.id, event);
  }

  const updates: { rowIndex: number; event: SheetEvent }[] = [];
  const appends: SheetEvent[] = [];
  for (const id of order) {
    const event = eventById.get(id)!;
    const rowIndex = rowById.get(id);
    if (rowIndex !== undefined) {
      updates.push({ rowIndex, event });
    } else {
      appends.push(event);
    }
  }

  return { updates, appends };
}
