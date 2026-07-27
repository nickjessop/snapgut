// Symptom taxonomy grounded in IBS / SIBO / FODMAP / histamine literature.
// See docs/research-and-insights.md. This replaces the old "mood" model.

export type SymptomCategory =
  | "Positive"
  | "Gas & bloating"
  | "Pain"
  | "Upper GI"
  | "Bowel"
  | "Systemic";

export interface SymptomDef {
  id: string;
  label: string;
  emoji: string;
  category: SymptomCategory;
  /** Extra search terms so "poop", "runs", etc. find the right chip. */
  aliases?: string[];
}

export type Severity = "mild" | "moderate" | "severe";

export const SEVERITIES: { value: Severity; label: string }[] = [
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "severe", label: "Severe" },
];

export const CATEGORY_ORDER: SymptomCategory[] = [
  "Positive",
  "Gas & bloating",
  "Pain",
  "Upper GI",
  "Bowel",
  "Systemic",
];

export const SYMPTOMS: SymptomDef[] = [
  // Positive — so logging isn't all-negative
  { id: "great", label: "Feeling great", emoji: "😃", category: "Positive" },
  { id: "comfortable", label: "Comfortable", emoji: "🙂", category: "Positive" },
  { id: "energized", label: "Energized", emoji: "⚡️", category: "Positive" },

  // Gas & bloating
  { id: "bloating", label: "Bloating", emoji: "🎈", category: "Gas & bloating", aliases: ["bloated", "swollen"] },
  { id: "gas", label: "Gassy", emoji: "💨", category: "Gas & bloating", aliases: ["flatulence", "farting", "wind"] },
  { id: "distension", label: "Distension", emoji: "🫃", category: "Gas & bloating", aliases: ["swollen belly", "visibly bloated"] },
  { id: "belching", label: "Belching", emoji: "😮‍💨", category: "Gas & bloating", aliases: ["burping", "burp"] },

  // Pain
  { id: "cramping", label: "Cramping", emoji: "🌀", category: "Pain", aliases: ["cramps", "spasm"] },
  { id: "sharp_pain", label: "Sharp pain", emoji: "⚡️", category: "Pain", aliases: ["stabbing", "intestinal pain"] },
  { id: "dull_ache", label: "Dull ache", emoji: "😣", category: "Pain", aliases: ["ache", "sore"] },
  { id: "lower_pain", label: "Lower-abdominal pain", emoji: "⬇️", category: "Pain", aliases: ["lower gut"] },
  { id: "upper_pain", label: "Upper-abdominal pain", emoji: "⬆️", category: "Pain", aliases: ["upper gut", "stomach pain"] },

  // Upper GI
  { id: "nausea", label: "Nausea", emoji: "🤢", category: "Upper GI", aliases: ["sick", "queasy"] },
  { id: "reflux", label: "Reflux / heartburn", emoji: "🔥", category: "Upper GI", aliases: ["acid", "gerd"] },
  { id: "early_full", label: "Early fullness", emoji: "🍽️", category: "Upper GI", aliases: ["full fast", "satiety"] },
  { id: "regurg", label: "Regurgitation", emoji: "↩️", category: "Upper GI" },

  // Bowel
  { id: "diarrhea", label: "Diarrhea", emoji: "💧", category: "Bowel", aliases: ["loose", "runs", "poop"] },
  { id: "constipation", label: "Constipation", emoji: "🧱", category: "Bowel", aliases: ["blocked", "hard", "poop"] },
  { id: "urgency", label: "Urgency", emoji: "🏃", category: "Bowel", aliases: ["gotta go", "rush"] },
  { id: "incomplete", label: "Incomplete evacuation", emoji: "🔁", category: "Bowel", aliases: ["not done"] },
  { id: "mucus", label: "Mucus in stool", emoji: "🫧", category: "Bowel" },

  // Systemic (histamine / gut-brain overlap)
  { id: "fatigue", label: "Fatigue / sluggish", emoji: "😴", category: "Systemic", aliases: ["tired", "sleepy"] },
  { id: "brain_fog", label: "Brain fog", emoji: "🌫️", category: "Systemic", aliases: ["foggy", "unfocused"] },
  { id: "headache", label: "Headache", emoji: "🤕", category: "Systemic", aliases: ["migraine"] },
  { id: "skin", label: "Skin flare / itch", emoji: "🌡️", category: "Systemic", aliases: ["rash", "hives", "itchy"] },
  { id: "flushing", label: "Flushing", emoji: "😳", category: "Systemic", aliases: ["red face", "hot"] },
  { id: "palpitations", label: "Palpitations", emoji: "💓", category: "Systemic", aliases: ["racing heart"] },
  { id: "joint_pain", label: "Joint pain", emoji: "🦴", category: "Systemic", aliases: ["achy joints"] },
];

const BY_ID = new Map(SYMPTOMS.map((s) => [s.id, s]));
export const getSymptom = (id: string) => BY_ID.get(id);

/** Fuzzy search across label + aliases. */
export function searchSymptoms(query: string): SymptomDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return SYMPTOMS;
  return SYMPTOMS.filter((s) => {
    if (s.label.toLowerCase().includes(q)) return true;
    return s.aliases?.some((a) => a.toLowerCase().includes(q)) ?? false;
  });
}

// Bristol Stool Scale — clinical standard for bowel-movement consistency.
export interface BristolType {
  type: number;
  emoji: string;
  short: string;
  tendency: "constipation" | "normal" | "diarrhea";
}

export const BRISTOL: BristolType[] = [
  { type: 1, emoji: "🥜", short: "Hard lumps", tendency: "constipation" },
  { type: 2, emoji: "🌰", short: "Lumpy sausage", tendency: "constipation" },
  { type: 3, emoji: "🌭", short: "Cracked sausage", tendency: "normal" },
  { type: 4, emoji: "🍌", short: "Smooth & soft", tendency: "normal" },
  { type: 5, emoji: "💧", short: "Soft blobs", tendency: "diarrhea" },
  { type: 6, emoji: "🥣", short: "Mushy", tendency: "diarrhea" },
  { type: 7, emoji: "🌊", short: "Watery", tendency: "diarrhea" },
];
