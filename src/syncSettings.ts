// Shared sync settings: the single owner of both destinations' enabled state, the
// persisted Pro entitlement snapshot, the per-destination sync outcome, and the
// backup-suppression predicate (cloud-sync Req 3, 14).
//
// The file is in two halves: the **pure core** (task 3.1) — the activity rule of
// Req 14.8/14.9/15.2 and the N-destination backup nudge gate of Req 14.1–14.3 —
// followed by the **stateful layer** (task 3.3) that persists the enabled state,
// the entitlement snapshot, the per-destination outcome, and the disclosure
// acknowledgement, and publishes all of it to subscribers.
//
// Requirement 14.10 holds structurally: nothing below writes
// `food-snap-last-backup` or `food-snap-backup-snooze`, so the nudge decision after
// a suppression period ends is exactly `isBackupDue(hasData)` from `backup.ts`.

import { getToken } from "./session";
import { isBackupDue } from "./backup";

/** The two independent sync destinations (Req 3.1). */
export type DestinationId = "cloud" | "sheets";

/** Last entitlement answer observed from the server (Req 1.8). */
export interface EntitlementSnapshot {
  pro: boolean;
  proUntil: number | null;
  /** Device clock when the server response arrived. */
  receivedAt: number;
}

/** Per-destination sync history, the input to the 72-hour failing rule (Req 14.9). */
export interface DestinationOutcome {
  lastOutcome: "success" | "failure" | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

/** Full observable state of the module, published to subscribers by task 3.3. */
export interface SyncSettingsSnapshot {
  /** Whether the persisted state has been read yet (Req 3.5, 3.9). */
  restored: boolean;
  enabled: Record<DestinationId, boolean>;
  /** `null` → treat as not Pro, the cold-start fail-closed default (Req 1.9). */
  entitlement: EntitlementSnapshot | null;
  /** Whether a Session_Token is held on the device (Req 1.6). */
  hasSession: boolean;
  outcome: Record<DestinationId, DestinationOutcome>;
  /** `${email}:${DISCLOSURE_VERSION}` (Req 18.6, 18.9). */
  disclosureAckFor: string | null;
  /** The destination whose last persistence attempt failed (Req 3.10). */
  persistFailed: DestinationId | null;
}

/**
 * The four conditions that decide whether a destination is currently protecting
 * the user's data, plus the clock the failing rule is evaluated against.
 *
 * `configured` is per-destination: for the Cloud destination a Session_Token is
 * held (Req 14.8); for the Sheets destination `VITE_GOOGLE_CLIENT_ID` is non-empty
 * **and** a spreadsheet id is stored (Req 15.2).
 */
export interface DestinationActivity {
  enabled: boolean;
  configured: boolean;
  entitled: boolean;
  outcome: DestinationOutcome;
  now: number;
}

/** The Req 14.9 grace period: 72 hours without a success makes a failure terminal. */
export const FAILING_GRACE_MS = 72 * 3_600_000;

/**
 * Whether a destination counts as failing under Req 14.9: its most recent outcome
 * was a failure **and** it has completed no successful sync within the preceding
 * 72 hours.
 *
 * A destination that has never succeeded is failing as soon as its last outcome is
 * a failure — there is no success inside the window to rescue it.
 */
function isFailing(a: DestinationActivity): boolean {
  if (a.outcome.lastOutcome !== "failure") return false;
  const { lastSuccessAt } = a.outcome;
  if (lastSuccessAt === null) return true;
  return a.now - lastSuccessAt > FAILING_GRACE_MS;
}

/**
 * The whole of Req 14.8 / 14.9 / 15.2 as one pure predicate:
 *
 * ```
 * enabled ∧ configured ∧ entitled ∧ ¬failing
 * ```
 *
 * Every one of the four conditions is necessary, so a destination that is merely
 * persisted as enabled — without entitlement, without configuration, or stuck in
 * the failing state — is inactive and therefore suppresses nothing.
 */
export function isDestinationActive(a: DestinationActivity): boolean {
  return a.enabled && a.configured && a.entitled && !isFailing(a);
}

/**
 * The single backup-suppression predicate of Req 14.1: true if and only if at
 * least one destination is active, each evaluated against its own active
 * definition rather than its persisted enabled state.
 *
 * An empty list suppresses nothing.
 */
export function shouldSuppressBackupNudge(destinations: DestinationActivity[]): boolean {
  return destinations.some(isDestinationActive);
}

/**
 * The backup nudge gate generalized from one destination to N (Req 14.2, 14.3):
 * `false` while suppression is on, and exactly `backupDue` otherwise.
 *
 * This replaces `shouldNudgeBackup(connected, backupDue)` in `googleSheets.ts`,
 * which is retired in task 4.1. With a single destination whose activity mirrors
 * the old `connected` flag, the two agree on every input.
 *
 * `backupDue` is expected to be `isBackupDue(hasData)` from `backup.ts`; this
 * function neither reads nor writes the backup timestamps itself (Req 14.10).
 */
export function shouldNudgeBackup(
  destinations: DestinationActivity[],
  backupDue: boolean,
): boolean {
  if (shouldSuppressBackupNudge(destinations)) return false;
  return backupDue;
}

// ===========================================================================
// Stateful layer: persistence, entitlement, outcome, disclosure (task 3.3)
// ===========================================================================

/**
 * Version of the privacy disclosure content (Req 18.6, 18.9). Bumping it
 * invalidates every stored acknowledgement, so the disclosure is shown again the
 * next time the Cloud sync settings screen is opened.
 */
export const DISCLOSURE_VERSION = 1;

// ---- Local persistence (localStorage) -------------------------------------
//
// Every key carries the `snapgut-sync-` prefix, which the account-deletion sweep
// in `SettingsView.reallyDelete()` already covers through its `snapgut` prefix
// filter (Req 17.3). One key per destination keeps the two enabled states
// genuinely independent: writing one can never disturb the other (Req 3.2).

const ENTITLEMENT_KEY = "snapgut-sync-entitlement";
const DISCLOSURE_ACK_KEY = "snapgut-sync-disclosure-ack";

function enabledKey(id: DestinationId): string {
  return `snapgut-sync-${id}-enabled`;
}
function outcomeKey(id: DestinationId): string {
  return `snapgut-sync-${id}-outcome`;
}

/**
 * The Sheets destination's stored spreadsheet id, read here by key rather than
 * through `googleSheets.getSpreadsheetId()` on purpose: task 4.1 makes
 * `googleSheets.ts` import this module for its enabled state and Pro gate, so
 * importing it back would form a cycle. The key is owned by `googleSheets.ts`
 * (`SPREADSHEET_ID_KEY`) and is only ever read here, never written.
 */
const SHEETS_SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";

/** Whether a usable `localStorage` is present (guards non-DOM contexts). */
function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** Read a raw string, or `null` when absent or unreadable (Req 3.6). */
function readRaw(key: string): string | null {
  if (!hasLocalStorage()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Best-effort write, reporting whether the value is actually durable. The
 * read-back check catches storage that accepts a write and silently drops it
 * (quota exhaustion, private-mode storage), which Req 3.10 treats the same as a
 * thrown error: the value stays in memory and the change is reported unsaved.
 */
function writeRaw(key: string, value: string): boolean {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(key, value);
    return localStorage.getItem(key) === value;
  } catch {
    return false;
  }
}

/** Best-effort removal; failure is non-fatal. */
function removeRaw(key: string): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* best-effort — non-fatal */
  }
}

// ---- Parsing (every malformed value fails closed) -------------------------

/**
 * Req 3.6: a destination is enabled only if its persisted value is exactly the
 * boolean `true`. Missing, unreadable, and any non-boolean value — including
 * `"1"`, `"yes"`, `null`, and arbitrary junk — read as disabled.
 */
function parseEnabled(raw: string | null): boolean {
  return raw === "true";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseEntitlement(raw: string | null): EntitlementSnapshot | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { pro, proUntil, receivedAt } = data as Record<string, unknown>;
  if (typeof pro !== "boolean") return null;
  if (proUntil !== null && !isFiniteNumber(proUntil)) return null;
  if (!isFiniteNumber(receivedAt)) return null;
  return { pro, proUntil, receivedAt };
}

function emptyOutcome(): DestinationOutcome {
  return { lastOutcome: null, lastSuccessAt: null, lastFailureAt: null };
}

function parseOutcome(raw: string | null): DestinationOutcome {
  if (raw === null) return emptyOutcome();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyOutcome();
  }
  if (!data || typeof data !== "object") return emptyOutcome();
  const { lastOutcome, lastSuccessAt, lastFailureAt } = data as Record<string, unknown>;
  const outcome: DestinationOutcome["lastOutcome"] =
    lastOutcome === "success" || lastOutcome === "failure" ? lastOutcome : null;
  return {
    lastOutcome: outcome,
    lastSuccessAt: isFiniteNumber(lastSuccessAt) ? lastSuccessAt : null,
    lastFailureAt: isFiniteNumber(lastFailureAt) ? lastFailureAt : null,
  };
}

// ---- In-memory state ------------------------------------------------------
//
// Everything but `hasSession` lives here; `hasSession` is derived from
// `session.getToken()` at read time so a sign-in or sign-out is reflected
// immediately without this module observing the token (Req 1.6).

interface InternalState {
  restored: boolean;
  enabled: Record<DestinationId, boolean>;
  entitlement: EntitlementSnapshot | null;
  outcome: Record<DestinationId, DestinationOutcome>;
  disclosureAckFor: string | null;
  persistFailed: DestinationId | null;
}

function initialState(): InternalState {
  return {
    restored: false,
    // Fail-closed until `restore()` has read persisted state (Req 3.5, 3.6).
    enabled: { cloud: false, sheets: false },
    entitlement: null,
    outcome: { cloud: emptyOutcome(), sheets: emptyOutcome() },
    disclosureAckFor: null,
    persistFailed: null,
  };
}

let state: InternalState = initialState();

/** Memoized so `restore()` is idempotent: one read, one notification (Req 3.9). */
let restorePromise: Promise<void> | null = null;

/** Subscribers notified with the full snapshot on any change (Req 3.8). */
const listeners = new Set<(s: SyncSettingsSnapshot) => void>();

/**
 * Publish the current snapshot to every subscriber. Synchronous, so the "within
 * 1 second" bound of Req 3.8 and Req 1.7 holds by construction.
 */
function notify(): void {
  const snapshot = getSnapshot();
  for (const listener of listeners) listener(snapshot);
}

// ---- Lifecycle (Req 3.4, 3.5, 3.9) ---------------------------------------

/**
 * Read every persisted value into memory and mark restoration complete.
 *
 * `localStorage` is synchronous, so this resolves on the first microtask —
 * comfortably inside the 3-second bound of Req 3.9. Idempotent: repeated calls
 * return the same promise, re-read nothing, and notify no one a second time, so
 * `App.tsx` can await it without guarding.
 */
export function restore(): Promise<void> {
  if (restorePromise) return restorePromise;

  state.enabled = {
    cloud: parseEnabled(readRaw(enabledKey("cloud"))),
    sheets: parseEnabled(readRaw(enabledKey("sheets"))),
  };
  state.entitlement = parseEntitlement(readRaw(ENTITLEMENT_KEY));
  state.outcome = {
    cloud: parseOutcome(readRaw(outcomeKey("cloud"))),
    sheets: parseOutcome(readRaw(outcomeKey("sheets"))),
  };
  const ack = readRaw(DISCLOSURE_ACK_KEY);
  state.disclosureAckFor = ack && ack.length > 0 ? ack : null;
  state.restored = true;

  restorePromise = Promise.resolve();
  notify();
  return restorePromise;
}

/** Whether persisted state has been read yet (Req 3.5, 3.9). */
export function isRestored(): boolean {
  return state.restored;
}

/** Whether a Session_Token is held on the device (Req 1.6). */
function hasSession(): boolean {
  try {
    return getToken() !== null;
  } catch {
    return false;
  }
}

/**
 * The full observable state, freshly copied so a caller cannot mutate module
 * state through it (Req 3.8).
 */
export function getSnapshot(): SyncSettingsSnapshot {
  return {
    restored: state.restored,
    enabled: { ...state.enabled },
    entitlement: state.entitlement ? { ...state.entitlement } : null,
    hasSession: hasSession(),
    outcome: { cloud: { ...state.outcome.cloud }, sheets: { ...state.outcome.sheets } },
    disclosureAckFor: state.disclosureAckFor,
    persistFailed: state.persistFailed,
  };
}

/**
 * Subscribe to state changes; returns an unsubscribe function. The listener is
 * not invoked on subscription — read {@link getSnapshot} for the current value —
 * and is invoked synchronously on every subsequent change (Req 3.8).
 */
export function subscribe(listener: (s: SyncSettingsSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- Destination enabled state (Req 3.1–3.4, 3.6, 3.10, 3.11) ------------

/**
 * The persisted enabled state of one destination, independent of the other and
 * of entitlement (Req 3.1). Disabled until `restore()` has run (Req 3.5).
 */
export function isDestinationEnabled(id: DestinationId): boolean {
  return state.enabled[id];
}

/**
 * Change one destination's enabled state, persisting it immediately (Req 3.4).
 *
 * Only that destination's own key is touched: the other destination's state, the
 * stored spreadsheet id, the Sync_Cursor, the Outbox, and the Local_Store are all
 * left alone (Req 3.2). All four combinations are therefore reachable and
 * persistable (Req 3.11).
 *
 * `{ persisted: false }` means the write failed or was silently dropped: the new
 * value is kept in memory for the rest of the session and `persistFailed` names
 * the destination, which Settings renders as "not saved" (Req 3.10).
 */
export function setDestinationEnabled(
  id: DestinationId,
  enabled: boolean,
): { persisted: boolean } {
  const persisted = writeRaw(enabledKey(id), String(enabled));

  const previousEnabled = state.enabled[id];
  const previousPersistFailed = state.persistFailed;

  state.enabled = { ...state.enabled, [id]: enabled };
  // Only this destination's failure is resolved by this write; an unsaved change
  // to the other destination keeps its indication.
  if (!persisted) {
    state.persistFailed = id;
  } else if (state.persistFailed === id) {
    state.persistFailed = null;
  }

  if (previousEnabled !== enabled || previousPersistFailed !== state.persistFailed) {
    notify();
  }
  return { persisted };
}

// ---- Entitlement (Req 1.7–1.9) -------------------------------------------

/**
 * Replace the persisted Pro_Entitlement snapshot with a value carried by a server
 * response and apply it to the gate immediately (Req 1.7, 1.8). `receivedAt` is
 * the device clock at the moment the response arrived.
 */
export function applyEntitlement(e: { pro: boolean; proUntil: number | null }): void {
  const snapshot: EntitlementSnapshot = {
    pro: e.pro,
    proUntil: e.proUntil,
    receivedAt: Date.now(),
  };
  state.entitlement = snapshot;
  // Best-effort: a failed entitlement write costs a cold start's worth of gating,
  // which Req 1.9 already fails closed, so it needs no unsaved indication.
  writeRaw(ENTITLEMENT_KEY, JSON.stringify(snapshot));
  notify();
}

/** The persisted snapshot, or `null` when none has ever been persisted (Req 1.9). */
export function getEntitlementSnapshot(): EntitlementSnapshot | null {
  return state.entitlement ? { ...state.entitlement } : null;
}

/**
 * The client-side Pro gate: `pro && (proUntil == null || proUntil > now)`, and
 * `false` whenever no snapshot has ever been persisted, so a cold start before
 * the first server response is treated as not Pro (Req 1.9).
 */
export function isProEntitled(): boolean {
  const e = state.entitlement;
  if (e === null) return false;
  if (!e.pro) return false;
  return e.proUntil === null || e.proUntil > Date.now();
}

// ---- Per-destination outcome (Req 14.9) ----------------------------------

/**
 * Record the result of a sync attempt for one destination. `at` is the device
 * clock of the attempt; a success sets `lastSuccessAt` and a failure sets
 * `lastFailureAt`, both of which the 72-hour failing rule reads (Req 14.9).
 */
export function recordSyncOutcome(
  id: DestinationId,
  outcome: "success" | "failure",
  at: number,
): void {
  const previous = state.outcome[id];
  const next: DestinationOutcome = {
    lastOutcome: outcome,
    lastSuccessAt: outcome === "success" ? at : previous.lastSuccessAt,
    lastFailureAt: outcome === "failure" ? at : previous.lastFailureAt,
  };
  state.outcome = { ...state.outcome, [id]: next };
  writeRaw(outcomeKey(id), JSON.stringify(next));
  notify();
}

/** One destination's sync history; all-null when nothing has been recorded. */
export function getOutcome(id: DestinationId): DestinationOutcome {
  return { ...state.outcome[id] };
}

// ---- Disclosure acknowledgement (Req 18.6, 18.9) -------------------------

/** The acknowledgement record identity: content version bound to the identity. */
function disclosureRecord(email: string): string {
  return `${email}:${DISCLOSURE_VERSION}`;
}

/**
 * Whether this device holds an acknowledgement of the **current** disclosure
 * content for this signed-in identity. A different email, or an acknowledgement
 * of an older `DISCLOSURE_VERSION`, does not count (Req 18.6).
 */
export function hasAckedDisclosure(email: string): boolean {
  return state.disclosureAckFor === disclosureRecord(email);
}

/** Persist the acknowledgement across app restarts (Req 18.9). */
export function ackDisclosure(email: string): void {
  const record = disclosureRecord(email);
  state.disclosureAckFor = record;
  writeRaw(DISCLOSURE_ACK_KEY, record);
  notify();
}

// ---- Convenience wrappers over the real state ----------------------------

/**
 * Whether the Sheets destination is configured (Req 15.2): the build-time
 * `VITE_GOOGLE_CLIENT_ID` holds a non-whitespace value **and** a spreadsheet id
 * is stored. Both are read directly rather than through `googleSheets.ts` to
 * avoid the import cycle that task 4.1 would otherwise create.
 */
function isSheetsConfigured(): boolean {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if ((clientId?.trim().length ?? 0) === 0) return false;
  const id = readRaw(SHEETS_SPREADSHEET_ID_KEY);
  return id !== null && id.length > 0;
}

/**
 * Both destinations described as activity inputs for {@link isDestinationActive},
 * evaluated against one clock value and the single shared entitlement gate
 * (Req 14.7, 14.8, 15.2). Cloud is configured when a Session_Token is held.
 */
export function describeDestinations(): DestinationActivity[] {
  const now = Date.now();
  const entitled = isProEntitled();
  return [
    {
      enabled: state.enabled.cloud,
      configured: hasSession(),
      entitled,
      outcome: getOutcome("cloud"),
      now,
    },
    {
      enabled: state.enabled.sheets,
      configured: isSheetsConfigured(),
      entitled,
      outcome: getOutcome("sheets"),
      now,
    },
  ];
}

/**
 * The Backup_Reminder decision for the current state: suppressed while any
 * destination is active, and otherwise exactly `isBackupDue(hasData)`
 * (Req 14.1–14.3). Reads the backup timestamps through `backup.ts` and writes
 * neither of them (Req 14.10).
 */
export function isBackupNudgeDue(hasData: boolean): boolean {
  return shouldNudgeBackup(describeDestinations(), isBackupDue(hasData));
}

// ---- Test support --------------------------------------------------------

/**
 * Drop all in-memory state, including the memoized `restore()` promise and every
 * subscriber, so a test can start from a clean module without re-importing.
 * Persisted values are left alone — clear `localStorage` for that.
 */
export function resetSyncSettingsForTests(): void {
  state = initialState();
  restorePromise = null;
  listeners.clear();
}

/** Remove every persisted key this module owns. Test-only. */
export function clearPersistedSyncSettingsForTests(): void {
  removeRaw(enabledKey("cloud"));
  removeRaw(enabledKey("sheets"));
  removeRaw(ENTITLEMENT_KEY);
  removeRaw(outcomeKey("cloud"));
  removeRaw(outcomeKey("sheets"));
  removeRaw(DISCLOSURE_ACK_KEY);
}
