// Shared sync settings: the single owner of both destinations' enabled state, the
// per-destination sync outcome, and the backup-suppression predicate (cloud-sync
// Req 3, 14).
//
// The file is in two halves: the **pure core** (task 3.1) — the activity rule of
// Req 14.8/14.9/15.2 and the N-destination backup nudge gate of Req 14.1–14.3 —
// followed by the **stateful layer** (task 3.3) that persists the enabled state,
// the per-destination outcome, and the disclosure acknowledgement, and publishes
// all of it to subscribers.

import { getToken } from "./session";
import { isBackupDue } from "./backup";

/** The sync destination (Req 3.1). */
export type DestinationId = "cloud";

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
  /** Whether a Session_Token is held on the device (Req 1.6). */
  hasSession: boolean;
  outcome: Record<DestinationId, DestinationOutcome>;
  /** `${email}:${DISCLOSURE_VERSION}` (Req 18.6, 18.9). */
  disclosureAckFor: string | null;
  /** The destination whose last persistence attempt failed (Req 3.10). */
  persistFailed: DestinationId | null;
}

/**
 * The conditions that decide whether a destination is currently protecting
 * the user's data, plus the clock the failing rule is evaluated against.
 *
 * `configured` is per-destination: for the Cloud destination a Session_Token is
 * held (Req 14.8).
 */
export interface DestinationActivity {
  enabled: boolean;
  configured: boolean;
  outcome: DestinationOutcome;
  now: number;
}

/** The Req 14.9 grace period: 72 hours without a success makes a failure terminal. */
export const FAILING_GRACE_MS = 72 * 3_600_000;

/**
 * Whether a destination counts as failing under Req 14.9: its most recent outcome
 * was a failure **and** it has completed no successful sync within the preceding
 * 72 hours.
 */
function isFailing(a: DestinationActivity): boolean {
  if (a.outcome.lastOutcome !== "failure") return false;
  const { lastSuccessAt } = a.outcome;
  if (lastSuccessAt === null) return true;
  return a.now - lastSuccessAt > FAILING_GRACE_MS;
}

/**
 * The activity predicate:
 *
 * ```
 * enabled ∧ configured ∧ ¬failing
 * ```
 */
export function isDestinationActive(a: DestinationActivity): boolean {
  return a.enabled && a.configured && !isFailing(a);
}

/**
 * The single backup-suppression predicate of Req 14.1: true if and only if at
 * least one destination is active.
 */
export function shouldSuppressBackupNudge(destinations: DestinationActivity[]): boolean {
  return destinations.some(isDestinationActive);
}

/**
 * The backup nudge gate generalized from one destination to N (Req 14.2, 14.3):
 * `false` while suppression is on, and exactly `backupDue` otherwise.
 */
export function shouldNudgeBackup(
  destinations: DestinationActivity[],
  backupDue: boolean,
): boolean {
  if (shouldSuppressBackupNudge(destinations)) return false;
  return backupDue;
}

// ===========================================================================
// Stateful layer: persistence, outcome, disclosure (task 3.3)
// ===========================================================================

/**
 * Version of the privacy disclosure content (Req 18.6, 18.9). Bumping it
 * invalidates every stored acknowledgement, so the disclosure is shown again the
 * next time the Cloud sync settings screen is opened.
 */
export const DISCLOSURE_VERSION = 1;

// ---- Local persistence (localStorage) -------------------------------------

const DISCLOSURE_ACK_KEY = "snapgut-sync-disclosure-ack";

function enabledKey(id: DestinationId): string {
  return `snapgut-sync-${id}-enabled`;
}
function outcomeKey(id: DestinationId): string {
  return `snapgut-sync-${id}-outcome`;
}



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
 * Best-effort write, reporting whether the value is actually durable.
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

function parseEnabled(raw: string | null): boolean {
  return raw === "true";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
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

interface InternalState {
  restored: boolean;
  enabled: Record<DestinationId, boolean>;
  outcome: Record<DestinationId, DestinationOutcome>;
  disclosureAckFor: string | null;
  persistFailed: DestinationId | null;
}

function initialState(): InternalState {
  return {
    restored: false,
    enabled: { cloud: false },
    outcome: { cloud: emptyOutcome() },
    disclosureAckFor: null,
    persistFailed: null,
  };
}

let state: InternalState = initialState();

let restorePromise: Promise<void> | null = null;

const listeners = new Set<(s: SyncSettingsSnapshot) => void>();

function notify(): void {
  const snapshot = getSnapshot();
  for (const listener of listeners) listener(snapshot);
}

// ---- Lifecycle (Req 3.4, 3.5, 3.9) ---------------------------------------

export function restore(): Promise<void> {
  if (restorePromise) return restorePromise;

  state.enabled = {
    cloud: parseEnabled(readRaw(enabledKey("cloud"))),
  };
  state.outcome = {
    cloud: parseOutcome(readRaw(outcomeKey("cloud"))),
  };
  const ack = readRaw(DISCLOSURE_ACK_KEY);
  state.disclosureAckFor = ack && ack.length > 0 ? ack : null;
  state.restored = true;

  restorePromise = Promise.resolve();
  notify();
  return restorePromise;
}

export function isRestored(): boolean {
  return state.restored;
}

function hasSession(): boolean {
  try {
    return getToken() !== null;
  } catch {
    return false;
  }
}

export function getSnapshot(): SyncSettingsSnapshot {
  return {
    restored: state.restored,
    enabled: { ...state.enabled },
    hasSession: hasSession(),
    outcome: { cloud: { ...state.outcome.cloud } },
    disclosureAckFor: state.disclosureAckFor,
    persistFailed: state.persistFailed,
  };
}

export function subscribe(listener: (s: SyncSettingsSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- Destination enabled state (Req 3.1–3.4, 3.6, 3.10, 3.11) ------------

export function isDestinationEnabled(id: DestinationId): boolean {
  return state.enabled[id];
}

export function setDestinationEnabled(
  id: DestinationId,
  enabled: boolean,
): { persisted: boolean } {
  const persisted = writeRaw(enabledKey(id), String(enabled));

  const previousEnabled = state.enabled[id];
  const previousPersistFailed = state.persistFailed;

  state.enabled = { ...state.enabled, [id]: enabled };
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

// ---- Per-destination outcome (Req 14.9) ----------------------------------

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

export function getOutcome(id: DestinationId): DestinationOutcome {
  return { ...state.outcome[id] };
}

// ---- Disclosure acknowledgement (Req 18.6, 18.9) -------------------------

function disclosureRecord(email: string): string {
  return `${email}:${DISCLOSURE_VERSION}`;
}

export function hasAckedDisclosure(email: string): boolean {
  return state.disclosureAckFor === disclosureRecord(email);
}

export function ackDisclosure(email: string): void {
  const record = disclosureRecord(email);
  state.disclosureAckFor = record;
  writeRaw(DISCLOSURE_ACK_KEY, record);
  notify();
}

// ---- Convenience wrappers over the real state ----------------------------

/**
 * The cloud destination described as an activity input for {@link isDestinationActive},
 * evaluated against one clock value. Cloud is configured when a Session_Token is held.
 */
export function describeDestinations(): DestinationActivity[] {
  const now = Date.now();
  return [
    {
      enabled: state.enabled.cloud,
      configured: hasSession(),
      outcome: getOutcome("cloud"),
      now,
    },
  ];
}

/**
 * The Backup_Reminder decision for the current state: suppressed while any
 * destination is active, and otherwise exactly `isBackupDue(hasData)`.
 */
export function isBackupNudgeDue(hasData: boolean): boolean {
  return shouldNudgeBackup(describeDestinations(), isBackupDue(hasData));
}

// ---- Test support --------------------------------------------------------

export function resetSyncSettingsForTests(): void {
  state = initialState();
  restorePromise = null;
  listeners.clear();
}

export function clearPersistedSyncSettingsForTests(): void {
  removeRaw(enabledKey("cloud"));
  removeRaw(outcomeKey("cloud"));
  removeRaw(DISCLOSURE_ACK_KEY);
}
