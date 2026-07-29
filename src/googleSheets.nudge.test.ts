import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { shouldNudgeBackup } from "./googleSheets";
import { isBackupDue } from "./backup";

// Feature: google-sheets-integration, Property 9: Backup nudge gate defers to existing behavior only when disconnected
//
// For any backup-timing state (last-backup time, snooze deadline, has-data flag),
// the effective nudge decision equals the original `isBackupDue(hasData)` when the
// integration is NOT connected, and is always `false` when the integration IS
// connected.
//
// Validates: Requirements 8.1, 8.4, 8.5

const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";

function clearBackupState(): void {
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
}

afterEach(() => {
  clearBackupState();
});

describe("shouldNudgeBackup (Property 9: nudge gate defers to existing behavior only when disconnected)", () => {
  // --- Primary property: the pure (connected, backupDue) domain ---
  it("returns false when connected and equals backupDue when disconnected", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (connected, backupDue) => {
        const result = shouldNudgeBackup(connected, backupDue);
        if (connected) {
          // Connected: always suppressed regardless of backupDue (Req 8.1).
          expect(result).toBe(false);
        } else {
          // Disconnected: defers exactly to the existing decision (Req 8.4, 8.5).
          expect(result).toBe(backupDue);
        }
      }),
      { numRuns: 100 },
    );
  });

  // --- Secondary variant: drive the real isBackupDue over arbitrary timing state ---
  //
  // Generates arbitrary last-backup timestamps, snooze deadlines, and hasData,
  // writes them into localStorage (jsdom), feeds the real isBackupDue(hasData)
  // result into shouldNudgeBackup, and asserts the gate defers when disconnected
  // and suppresses when connected. localStorage is cleaned between runs.
  it("defers to the real isBackupDue when disconnected and suppresses it when connected", () => {
    const now = Date.now();
    const DAY_MS = 86_400_000;
    // Timestamps spanning ~30 days before to ~30 days after now (covers overdue,
    // recent, future-snooze, and past-snooze cases).
    const arbTimestamp = fc.integer({ min: now - 30 * DAY_MS, max: now + 30 * DAY_MS });

    fc.assert(
      fc.property(
        fc.option(arbTimestamp, { nil: undefined }),
        fc.option(arbTimestamp, { nil: undefined }),
        fc.boolean(),
        fc.boolean(),
        (lastBackup, snooze, hasData, connected) => {
          clearBackupState();
          if (lastBackup !== undefined) {
            localStorage.setItem(LAST_BACKUP_KEY, String(lastBackup));
          }
          if (snooze !== undefined) {
            localStorage.setItem(SNOOZE_KEY, String(snooze));
          }

          const backupDue = isBackupDue(hasData);
          const result = shouldNudgeBackup(connected, backupDue);

          if (connected) {
            expect(result).toBe(false);
          } else {
            expect(result).toBe(backupDue);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // --- Concrete examples ---
  it("suppresses the nudge when connected even if backup is due", () => {
    expect(shouldNudgeBackup(true, true)).toBe(false);
  });

  it("suppresses the nudge when connected and backup is not due", () => {
    expect(shouldNudgeBackup(true, false)).toBe(false);
  });

  it("shows the nudge when disconnected and backup is due", () => {
    expect(shouldNudgeBackup(false, true)).toBe(true);
  });

  it("hides the nudge when disconnected and backup is not due", () => {
    expect(shouldNudgeBackup(false, false)).toBe(false);
  });
});
