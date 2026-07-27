// Full backup / restore of the timeline (events + photos) as a single JSON file.
// Photos are Blobs in IndexedDB, so we inline them as base64 data URLs for export
// and rebuild them on import. This is the local-first durability path: the file
// can be saved to Files / iCloud Drive via the share sheet. See docs.

import { getEvents, addEvent, type LogEvent } from "./db";

const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";
export const BACKUP_REMINDER_DAYS = 7;
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
  const payload = { app: "food-snap", version: 1, exportedAt: Date.now(), events: out };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  return { blob, count: events.length };
}

// ---- export ----

/** Build a backup and hand it to the OS (share sheet → Files/iCloud, or download). */
export async function exportBackup(): Promise<number> {
  const { blob, count } = await buildBackupBlob();
  const name = `food-snap-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: "application/json" });

  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: "Food Snap backup" });
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
    throw new Error("That doesn't look like a Food Snap backup.");
  }

  let n = 0;
  for (const raw of data.events as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") continue;
    const ev: Record<string, unknown> = { ...raw };
    if (ev.type === "meal" && typeof ev.photoDataUrl === "string") {
      ev.photo = await dataUrlToBlob(ev.photoDataUrl);
      delete ev.photoDataUrl;
    }
    await addEvent(ev as unknown as LogEvent);
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
