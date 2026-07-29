// Full backup / restore of the timeline (events + photos) as a single JSON file.
// Photos are Blobs in IndexedDB, so we inline them as base64 data URLs for export
// and rebuild them on import. This is the local-first durability path: the file
// can be saved to Files / iCloud Drive via the share sheet. See docs.

import {
  getEvents,
  getRecord,
  putEvent,
  attachPhoto,
  isTombstone,
  type LogEvent,
  type StoredRecord,
} from "./db";

const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";
export const BACKUP_REMINDER_DAYS = 3;
const DAY_MS = 86_400_000;

// ---- serialization helpers ----

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

/**
 * Reads through `getEvents()`, which returns real events only, so tombstones
 * stay out of backup files and the on-disk format is unchanged.
 */
async function buildBackupBlob(): Promise<{ blob: Blob; count: number }> {
  const events = await getEvents();
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.type === "meal" && e.photo) {
      const { photo, ...rest } = e;
      out.push({ ...rest, photoDataUrl: await blobToDataUrl(photo) });
    } else {
      out.push({ ...e });
    }
  }
  const payload = { app: "snapgut", version: 1, exportedAt: Date.now(), events: out };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  return { blob, count: events.length };
}

// ---- export ----

/** Build a backup and hand it to the OS (share sheet → Files/iCloud, or download). */
export async function exportBackup(): Promise<number> {
  const { blob, count } = await buildBackupBlob();
  const name = `snapgut-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: "application/json" });

  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: "SnapGut backup" });
      markBackedUp();
      return count;
    } catch (e) {
      // user cancelled the share sheet — don't force a download
      if ((e as Error).name === "AbortError") return count;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  markBackedUp();
  return count;
}

// ---- import ----

/**
 * Stable key-sorted JSON of every field but the photo, giving the total ordering
 * Requirement 8.3 needs for the final tie. Photos are excluded because they
 * never decide a merge (Req 8.7).
 */
function canonicalKey(r: StoredRecord): string {
  const entries = Object.entries(r as unknown as Record<string, unknown>)
    .filter(([k, v]) => k !== "photo" && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Requirement 8's ordering applied to one imported entry against what the
 * Local_Store already holds for that `id` (Req 5.10): greater Revision_Time,
 * then tombstone-wins on a tie, then greater `createdAt`, then the total
 * ordering above, with the record ordered last retained.
 *
 * Local to the import path on purpose: task 7.1 introduces the shared
 * `compareForMerge` / `mergeRecords` that sync and the server both use, and this
 * helper is replaced by it then. Until then the import path still needs the rule.
 */
function importedWins(incoming: StoredRecord, existing: StoredRecord): boolean {
  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt > existing.updatedAt; // Req 8.1
  }
  const incomingDeleted = isTombstone(incoming);
  const existingDeleted = isTombstone(existing);
  if (incomingDeleted !== existingDeleted) return incomingDeleted; // Req 8.2
  if (incoming.createdAt !== existing.createdAt) {
    return incoming.createdAt > existing.createdAt; // Req 8.3
  }
  return canonicalKey(incoming) > canonicalKey(existing); // Req 8.3
}

/** The photo the Local_Store already holds for an id, if any. */
function localPhoto(existing: StoredRecord): Blob | undefined {
  if (isTombstone(existing) || existing.type !== "meal") return undefined;
  return existing.photo;
}

/** Restore events from a backup file. Merges by id (idempotent), returns count. */
export async function importBackup(file: File): Promise<number> {
  const text = await file.text();
  let data: { events?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!data || !Array.isArray(data.events)) {
    throw new Error("That doesn't look like a SnapGut backup.");
  }

  // One clock value for the whole import: the fallback Revision_Time of
  // Requirement 5.7 is "the device clock at the time of the import".
  const importedAt = Date.now();

  let n = 0;
  for (const raw of data.events as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") continue;
    const { photoDataUrl, ...fields } = raw;
    const ev: Record<string, unknown> = { ...fields };
    if (ev.type === "meal" && typeof photoDataUrl === "string") {
      ev.photo = await dataUrlToBlob(photoDataUrl); // Req 16.5
    }
    // A file written before v3 carries no Revision_Time (Req 5.7).
    if (!Number.isInteger(ev.updatedAt)) {
      ev.updatedAt = Number.isInteger(ev.createdAt) ? ev.createdAt : importedAt;
    }
    const incoming = ev as unknown as LogEvent;

    const existing = await getRecord(incoming.id);
    if (!existing) {
      // `touch: false` keeps the revision the file carries rather than stamping
      // a fresh one, so importing the same file twice is a no-op (Req 5.7).
      await putEvent(incoming, { touch: false, now: importedAt });
    } else if (importedWins(incoming, existing)) {
      // The photo is on-device-only data and no part of the merge (Req 8.7), so
      // a local photo survives an imported entry that carries none.
      const photo = incoming.type === "meal" ? (incoming.photo ?? localPhoto(existing)) : undefined;
      const toStore = photo ? { ...incoming, photo } : incoming;
      await putEvent(toStore, { touch: false, now: importedAt });
    } else if (incoming.type === "meal" && incoming.photo) {
      // The local copy keeps the non-photo fields, but the photo in the file is
      // still restored — without touching the Revision_Time or the Outbox,
      // because a photo is not a new revision (Req 10.7, 16.5).
      await attachPhoto(incoming.id, incoming.photo);
    }
    n++;
  }
  return n;
}

// ---- reminder bookkeeping ----

export function getLastBackupAt(): number | null {
  const v = localStorage.getItem(LAST_BACKUP_KEY);
  return v ? Number(v) : null;
}

export function daysSince(ts: number): number {
  return Math.floor((Date.now() - ts) / DAY_MS);
}

export function markBackedUp(): void {
  localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
  localStorage.removeItem(SNOOZE_KEY);
}

export function snoozeReminder(): void {
  localStorage.setItem(SNOOZE_KEY, String(Date.now() + BACKUP_REMINDER_DAYS * DAY_MS));
}

/** Whether to nudge the user to back up (has data, overdue, not snoozed). */
export function isBackupDue(hasData: boolean): boolean {
  if (!hasData) return false;
  const snooze = Number(localStorage.getItem(SNOOZE_KEY) || 0);
  if (Date.now() < snooze) return false;
  const last = getLastBackupAt();
  if (last === null) return true; // never backed up
  return daysSince(last) >= BACKUP_REMINDER_DAYS;
}

/** Best-effort request for persistent storage (guards against eviction). */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not supported — non-fatal */
  }
}
