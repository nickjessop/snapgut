import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Severity } from "./symptoms";

export interface LoggedSymptom {
  id: string; // SymptomDef id
  severity: Severity;
}

/**
 * Confidence in an ingredient:
 * - "confident": clearly visible in the photo, or explicitly named by the user.
 * - "maybe": inferred from the dish/context (e.g. instant ramen → likely wheat,
 *   palm oil, MSG). Weaker signal for pattern-finding.
 */
export type Confidence = "confident" | "maybe";

export interface Ingredient {
  name: string;
  confidence: Confidence;
}

export interface MealAnalysis {
  dish: string;
  ingredients: Ingredient[];
}

// ---- Event model ----
// Everything is a timestamped event on one timeline. Meals and symptoms are
// logged independently because symptoms often occur hours after eating.

interface BaseEvent {
  id: string;
  createdAt: number; // epoch ms — when the thing actually happened
  note?: string;
}

export interface MealEvent extends BaseEvent {
  type: "meal";
  dish: string;
  ingredients: Ingredient[];
  photo?: Blob; // on-device only
}

export interface SymptomEvent extends BaseEvent {
  type: "symptom";
  symptoms: LoggedSymptom[];
}

export interface BowelEvent extends BaseEvent {
  type: "bowel";
  bristol: number; // Bristol Stool Scale 1–7
  symptoms?: LoggedSymptom[]; // optional (e.g. urgency)
}

export type StressLevel = "low" | "medium" | "high";
export type SleepQuality = "poor" | "ok" | "good";

// Gut-brain axis: stress and sleep influence gut symptoms, so we capture them
// as their own lightweight check-in event.
export interface CheckinEvent extends BaseEvent {
  type: "checkin";
  stress?: StressLevel;
  sleep?: SleepQuality;
}

export type LogEvent = MealEvent | SymptomEvent | BowelEvent | CheckinEvent;

// ---- Helpers ----

export function confidentNames(e: MealEvent): string[] {
  return e.ingredients.filter((i) => i.confidence === "confident").map((i) => i.name);
}
export function allNames(e: MealEvent): string[] {
  return e.ingredients.map((i) => i.name);
}

// ---- IndexedDB ----

interface FoodSnapDB extends DBSchema {
  events: {
    key: string;
    value: LogEvent;
    indexes: { "by-createdAt": number };
  };
}

let dbPromise: Promise<IDBPDatabase<FoodSnapDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<FoodSnapDB>("food-snap", 2, {
      upgrade(db, oldVersion) {
        // v1 stored a single "entries" store; the event model replaces it.
        if (oldVersion < 2 && db.objectStoreNames.contains("entries" as never)) {
          db.deleteObjectStore("entries" as never);
        }
        if (!db.objectStoreNames.contains("events")) {
          const store = db.createObjectStore("events", { keyPath: "id" });
          store.createIndex("by-createdAt", "createdAt");
        }
      },
    });
  }
  return dbPromise;
}

export async function addEvent(event: LogEvent): Promise<void> {
  const db = await getDB();
  await db.put("events", event);
}

export async function getEvents(): Promise<LogEvent[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("events", "by-createdAt");
  return all.reverse(); // newest first
}

export async function deleteEvent(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("events", id);
}

// ---- CSV export (unified timeline) ----

export function toCSV(events: LogEvent[], labelFor: (id: string) => string): string {
  const header = [
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
  ];

  const symptomsText = (syms?: LoggedSymptom[]) =>
    (syms ?? []).map((s) => `${labelFor(s.id)} (${s.severity})`).join("; ");

  const rows = events.map((e) => {
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
      confident = e.ingredients.filter((i) => i.confidence === "confident").map((i) => i.name).join("; ");
      maybe = e.ingredients.filter((i) => i.confidence === "maybe").map((i) => i.name).join("; ");
    } else if (e.type === "symptom") {
      symptoms = symptomsText(e.symptoms);
    } else if (e.type === "bowel") {
      bristol = String(e.bristol);
      symptoms = symptomsText(e.symptoms);
    } else if (e.type === "checkin") {
      stress = e.stress ?? "";
      sleep = e.sleep ?? "";
    }

    return [dt, e.type, dish, confident, maybe, symptoms, bristol, stress, sleep, e.note ?? ""].map(csvEscape);
  });

  return [header, ...rows].map((r) => r.join(",")).join("\r\n");
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
