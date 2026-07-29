// Feature: cloud-sync, task 2.4 — Manual_Backup import on the v3 write path.
//
// `importBackup` used to be a blind `put` per entry. On v3 it has to do two
// things it did not before: give an entry that carries no Revision_Time one
// (Req 5.7), and resolve an entry whose `id` is already in the Local_Store by
// the merge rule of Requirement 8 (Req 5.10), leaving exactly one entry.
//
// jsdom has no IndexedDB, so `fake-indexeddb/auto` installs a real one: these
// assertions are about what actually lands in the store, so a stand-in would
// not honestly exercise them.
//
// Validates: Requirements 5.7, 5.10

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { importBackup } from "./backup";
import { getRecord, putEvent, deleteEvent, isTombstone, type LogEvent } from "./db";

let idCounter = 0;
function freshId(): string {
  return `import-${++idCounter}`;
}

/**
 * A backup file holding the given raw entries, as `importBackup` reads it.
 * jsdom's `File` has no `text()`, and that one method is the whole surface
 * `importBackup` touches, so the file is stood up around it.
 */
function backupFile(entries: Record<string, unknown>[]): File {
  const payload = { app: "snapgut", version: 1, exportedAt: Date.now(), events: entries };
  const json = JSON.stringify(payload);
  return { name: "snapgut-backup.json", text: async () => json } as unknown as File;
}

describe("importBackup on the v3 write path", () => {
  it("sets updatedAt = createdAt for an entry that carries no Revision_Time (Req 5.7)", async () => {
    const id = freshId();
    const n = await importBackup(
      backupFile([{ id, type: "checkin", createdAt: 1_700_000_000_000, stress: "low" }]),
    );

    expect(n).toBe(1);
    const stored = await getRecord(id);
    expect(stored?.updatedAt).toBe(1_700_000_000_000);
  });

  it("falls back to the import clock when createdAt is not an integer (Req 5.7)", async () => {
    const id = freshId();
    const before = Date.now();
    await importBackup(backupFile([{ id, type: "checkin", createdAt: "yesterday" }]));
    const after = Date.now();

    const stored = await getRecord(id);
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(stored?.updatedAt).toBeLessThanOrEqual(after);
  });

  it("keeps the imported entry when it carries the greater Revision_Time (Req 5.10, 8.1)", async () => {
    const id = freshId();
    const local: LogEvent = {
      id,
      type: "checkin",
      createdAt: 1_000,
      updatedAt: 5_000,
      note: "local",
    };
    await putEvent(local, { touch: false });

    await importBackup(
      backupFile([{ id, type: "checkin", createdAt: 1_000, updatedAt: 9_000, note: "imported" }]),
    );

    const stored = await getRecord(id);
    expect(stored?.updatedAt).toBe(9_000);
    expect((stored as LogEvent).note).toBe("imported");
  });

  it("keeps the local entry when it holds the greater Revision_Time (Req 5.10, 8.1)", async () => {
    const id = freshId();
    await putEvent(
      { id, type: "checkin", createdAt: 1_000, updatedAt: 9_000, note: "local" },
      { touch: false },
    );

    await importBackup(
      backupFile([{ id, type: "checkin", createdAt: 1_000, updatedAt: 5_000, note: "imported" }]),
    );

    const stored = await getRecord(id);
    expect(stored?.updatedAt).toBe(9_000);
    expect((stored as LogEvent).note).toBe("local");
  });

  it("keeps a local tombstone on an equal Revision_Time rather than resurrecting (Req 8.2)", async () => {
    const id = freshId();
    await putEvent({ id, type: "checkin", createdAt: 1_000, updatedAt: 1_000 }, { touch: false });
    const deletedAt = await deleteEvent(id);

    await importBackup(
      backupFile([{ id, type: "checkin", createdAt: 1_000, updatedAt: deletedAt, note: "back?" }]),
    );

    const stored = await getRecord(id);
    expect(stored && isTombstone(stored)).toBe(true);
    expect(stored?.updatedAt).toBe(deletedAt);
  });

  it("is idempotent: importing the same file twice leaves one unchanged entry (Req 5.10)", async () => {
    const id = freshId();
    const file = () =>
      backupFile([{ id, type: "bowel", createdAt: 2_000, updatedAt: 7_000, bristol: 4 }]);

    await importBackup(file());
    const first = await getRecord(id);
    await importBackup(file());
    const second = await getRecord(id);

    expect(second).toEqual(first);
    expect(second?.updatedAt).toBe(7_000);
  });
});
