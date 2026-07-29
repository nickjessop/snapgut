// Shared sync settings: the single owner of both destinations' enabled state, the
// persisted Pro entitlement snapshot, the per-destination sync outcome, and the
// backup-suppression predicate (cloud-sync Req 3, 14).
//
// This file currently holds only the **pure core** (task 3.1): the activity rule
// of Req 14.8/14.9/15.2 and the N-destination backup nudge gate of Req 14.1–14.3.
// The persistence, entitlement, outcome, and disclosure layer lands in task 3.3 on
// top of the types declared here.
//
// Requirement 14.10 holds structurally: nothing below reads or writes
// `food-snap-last-backup` or `food-snap-backup-snooze`, so the nudge decision after
// a suppression period ends is exactly `isBackupDue(hasData)` from `backup.ts`.

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
