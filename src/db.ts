import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { Severity } from "./symptoms";

export interface LoggedSymptom {
  id: string; // SymptomDef id
  severity: Severity;
}

export interface Entry {
  id: string;
  createdAt: number; // epoch ms
  foods: string[];
  symptoms: LoggedSymptom[];
  bristol?: number; // Bristol Stool Scale 1–7, if a bowel movement was logged
  note?: string;
  photo?: Blob; // stored on-device only
}

interface FoodSnapDB extends DBSchema {
  entries: {
    key: string;
    value: Entry;
    indexes: { "by-createdAt": number };
  };
}

let dbPromise: Promise<IDBPDatabase<FoodSnapDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<FoodSnapDB>("food-snap", 1, {
      upgrade(db) {
        const store = db.createObjectStore("entries", { keyPath: "id" });
        store.createIndex("by-createdAt", "createdAt");
      },
    });
  }
  return dbPromise;
}

export async function addEntry(entry: Entry): Promise<void> {
  const db = await getDB();
  await db.put("entries", entry);
}

export async function getEntries(): Promise<Entry[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("entries", "by-createdAt");
  return all.reverse(); // newest first
}

export async function deleteEntry(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("entries", id);
}

/** Build a CSV string from all entries (photos excluded). */
export function toCSV(entries: Entry[], labelFor: (id: string) => string): string {
  const header = ["date", "time", "foods", "symptoms", "bristol", "note"];
  const rows = entries.map((e) => {
    const d = new Date(e.createdAt);
    const symptoms = e.symptoms
      .map((s) => `${labelFor(s.id)} (${s.severity})`)
      .join("; ");
    return [
      d.toISOString().slice(0, 10),
      d.toTimeString().slice(0, 5),
      e.foods.join("; "),
      symptoms,
      e.bristol ? String(e.bristol) : "",
      e.note ?? "",
    ].map(csvEscape);
  });
  return [header, ...rows].map((r) => r.join(",")).join("\r\n");
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
