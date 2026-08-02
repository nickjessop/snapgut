// Full backup / restore of the timeline (events + photos) as a single JSON file.
// Photos are Blobs in IndexedDB, so we inline them as base64 data URLs for export
// and rebuild them on import. This is the local-first durability path: the file
// can be saved to Files / iCloud Drive via the share sheet. See docs.

import { compareForMerge } from "./cloudSync";
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

/**
 * Decode a `data:` URL to a Blob, without `fetch`.
 *
 * This used to be `fetch(url).then(r => r.blob())`, which is the tidy way to do it
 * and stopped working the moment the Content-Security-Policy was tightened:
 * `connect-src 'self'` governs `fetch`, and a `data:` URL is not `'self'`, so every
 * photo restore failed with a bare "Failed to fetch". The failure was invisible in
 * testing because a backup with no photos imports perfectly — only a file
 * containing a meal photo hits this path, and that is most real backups.
 *
 * Decoding by hand has no origin to be blocked by, so no CSP directive can reach
 * it. It is also faster and synchronous. The accepted input is unchanged, so files
 * written by any previous version still restore.
 *
 * Exported so the decoding can be asserted directly: jsdom's IndexedDB stand-in does
 * not round-trip a Blob, so reading one back out of the store proves nothing.
 */
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) {
    throw new Error("not a data URL");
  }
  const header = url.slice(0, comma);
  const body = url.slice(comma + 1);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? "application/octet-stream";

  // Percent-encoded rather than base64 is legal and is what a hand-edited file is
  // most likely to contain, so it is handled rather than rejected.
  if (!/;base64/i.test(header)) {
    return new Blob([decodeURIComponent(body)], { type: mime });
  }

  // `atob` yields a string of char codes; a Blob needs the bytes.
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
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
 * Requirement 8's ordering applied to one imported entry against what the
 * Local_Store already holds for that `id` (Req 5.10). The rule itself lives in
 * `cloudSync.ts`, shared with the Sync_Cycle merge, so import and sync can never
 * disagree about which revision wins.
 */
function importedWins(incoming: StoredRecord, existing: StoredRecord): boolean {
  return compareForMerge(incoming, existing) > 0;
}

/** The photo the Local_Store already holds for an id, if any. */
function localPhoto(existing: StoredRecord): Blob | undefined {
  if (isTombstone(existing) || existing.type !== "meal") return undefined;
  return existing.photo;
}

/** What a restore managed to do. `skipped` counts entries that could not be read. */
export interface ImportResult {
  imported: number;
  skipped: number;
}

/**
 * Restore events from a backup file. Merges by id, so importing twice is a no-op.
 *
 * Every entry is attempted independently. Before, a single unreadable one threw and
 * abandoned the whole file — so one corrupt photo among a year of logs cost the
 * entire restore, which is precisely the wrong failure for the feature that exists
 * to recover data. Now a bad entry is skipped, a bad *photo* still restores its
 * event, and the caller is told how many were dropped.
 */
export async function importBackup(file: File): Promise<ImportResult> {
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

  let imported = 0;
  let skipped = 0;
  for (const raw of data.events as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") {
      skipped++;
      continue;
    }
    try {
      const { photoDataUrl, ...fields } = raw;
      const ev: Record<string, unknown> = { ...fields };
      if (ev.type === "meal" && typeof photoDataUrl === "string") {
        try {
          ev.photo = dataUrlToBlob(photoDataUrl); // Req 16.5
        } catch {
          // An unreadable photo must not cost the entry it belongs to. The dish,
          // ingredients, note and timestamp are the parts the analysis uses.
        }
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
        const photo =
          incoming.type === "meal" ? (incoming.photo ?? localPhoto(existing)) : undefined;
        const toStore = photo ? { ...incoming, photo } : incoming;
        await putEvent(toStore, { touch: false, now: importedAt });
      } else if (incoming.type === "meal" && incoming.photo) {
        // The local copy keeps the non-photo fields, but the photo in the file is
        // still restored — without touching the Revision_Time or the Outbox,
        // because a photo is not a new revision (Req 10.7, 16.5).
        await attachPhoto(incoming.id, incoming.photo);
      }
      imported++;
    } catch {
      // A single unreadable entry costs itself and nothing else.
      skipped++;
    }
  }

  // Every entry failing is a broken file, not a successful restore of nothing —
  // reporting "Restored 0 items" would read as success.
  if (imported === 0 && skipped > 0) {
    throw new Error("That backup couldn't be read — no entries were restored.");
  }
  return { imported, skipped };
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
