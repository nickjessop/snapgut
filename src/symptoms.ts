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
  /**
   * One or two sentences on what this covers, shown when a symptom is held.
   *
   * The job is boundary-drawing, not education: several of these overlap in ordinary
   * speech — bloating against distension, cramping against a dull ache, urgency
   * against diarrhoea — and a log is only worth analysing if the same feeling lands
   * on the same chip each time. Descriptive, never diagnostic.
   */
  description?: string;
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
  { id: "great", label: "Feeling great", emoji: "😃", category: "Positive",
    description:
      "A good day: no discomfort you would think to mention. Worth logging — a diary of only bad days cannot show what agrees with you." },
  { id: "comfortable", label: "Comfortable", emoji: "🙂", category: "Positive",
    description:
      "Nothing wrong, nothing notable. The ordinary baseline you are comparing bad days against." },
  { id: "energized", label: "Energized", emoji: "⚡️", category: "Positive",
    description:
      "Steady energy after eating, rather than the dip or heaviness a meal sometimes brings." },

  // Gas & bloating
  { id: "bloating", label: "Bloating", emoji: "🎈", category: "Gas & bloating", aliases: ["bloated", "swollen"],
    description:
      "A feeling of pressure or fullness from the inside, whether or not you look any different. Use Distension instead when your belly visibly changes shape." },
  { id: "gas", label: "Gassy", emoji: "💨", category: "Gas & bloating", aliases: ["flatulence", "farting", "wind"],
    description:
      "Passing more wind than usual. Normal in itself — what matters is when it changes." },
  { id: "distension", label: "Distension", emoji: "🫃", category: "Gas & bloating", aliases: ["swollen belly", "visibly bloated"],
    description:
      "Your belly visibly larger — waistband tighter, clothes not sitting right. The visible companion to bloating, and worth separating because they do not always occur together." },
  { id: "belching", label: "Belching", emoji: "😮‍💨", category: "Gas & bloating", aliases: ["burping", "burp"],
    description:
      "Burping more than usual, often soon after eating or drinking." },

  // Pain
  { id: "cramping", label: "Cramping", emoji: "🌀", category: "Pain", aliases: ["cramps", "spasm"],
    description:
      "Pain that comes in waves and eases off, as muscle squeezes and releases. Choose a Dull ache for pain that simply sits there." },
  { id: "sharp_pain", label: "Sharp pain", emoji: "⚡️", category: "Pain", aliases: ["stabbing", "intestinal pain"],
    description:
      "A sudden, well-located, stabbing pain, distinct from a general ache." },
  { id: "dull_ache", label: "Dull ache", emoji: "😣", category: "Pain", aliases: ["ache", "sore"],
    description:
      "A steady, spread-out soreness with no clear edge, in the background rather than in waves." },
  { id: "lower_pain", label: "Lower-abdominal pain", emoji: "⬇️", category: "Pain", aliases: ["lower gut"],
    description:
      "Pain below the navel. Often reported alongside bowel changes." },
  { id: "upper_pain", label: "Upper-abdominal pain", emoji: "⬆️", category: "Pain", aliases: ["upper gut", "stomach pain"],
    description:
      "Pain above the navel, around the stomach and under the ribs. Often reported alongside reflux or nausea." },

  // Upper GI
  { id: "nausea", label: "Nausea", emoji: "🤢", category: "Upper GI", aliases: ["sick", "queasy"],
    description:
      "Feeling like you might be sick, whether or not you are." },
  { id: "reflux", label: "Reflux / heartburn", emoji: "🔥", category: "Upper GI", aliases: ["acid", "gerd"],
    description:
      "Burning rising from the stomach into the chest or throat, sometimes with a sour taste. Often worse lying down or soon after eating." },
  { id: "early_full", label: "Early fullness", emoji: "🍽️", category: "Upper GI", aliases: ["full fast", "satiety"],
    description:
      "Full much sooner than the amount you ate would explain — a few mouthfuls and you cannot continue." },
  { id: "regurg", label: "Regurgitation", emoji: "↩️", category: "Upper GI",
    description:
      "Food or liquid coming back up into your mouth without the effort of being sick." },

  // Bowel
  { id: "diarrhea", label: "Diarrhea", emoji: "💧", category: "Bowel", aliases: ["loose", "runs", "poop"],
    description:
      "Loose or watery stools, or more of them than usual. Bristol types 5 to 7 in a bowel log." },
  { id: "constipation", label: "Constipation", emoji: "🧱", category: "Bowel", aliases: ["blocked", "hard", "poop"],
    description:
      "Hard or difficult stools, or going less often than is normal for you. Bristol types 1 to 2." },
  { id: "urgency", label: "Urgency", emoji: "🏃", category: "Bowel", aliases: ["gotta go", "rush"],
    description:
      "Having to reach a toilet immediately, whatever the stool turns out to be like. Separate from diarrhoea, though they often arrive together." },
  { id: "incomplete", label: "Incomplete evacuation", emoji: "🔁", category: "Bowel", aliases: ["not done"],
    description:
      "Still feeling unfinished after going, as though more is left." },
  { id: "mucus", label: "Mucus in stool", emoji: "🫧", category: "Bowel",
    description:
      "Visible slime in or around the stool." },

  // Systemic (histamine / gut-brain overlap)
  { id: "fatigue", label: "Fatigue / sluggish", emoji: "😴", category: "Systemic", aliases: ["tired", "sleepy"],
    description:
      "Unusually drained or heavy, particularly in the hours after a meal." },
  { id: "brain_fog", label: "Brain fog", emoji: "🌫️", category: "Systemic", aliases: ["foggy", "unfocused"],
    description:
      "Thinking feels slow or unfocused, hard to hold a thread." },
  { id: "headache", label: "Headache", emoji: "🤕", category: "Systemic", aliases: ["migraine"],
    description:
      "Any head pain, from a dull band to a migraine." },
  { id: "skin", label: "Skin flare / itch", emoji: "🌡️", category: "Systemic", aliases: ["rash", "hives", "itchy"],
    description:
      "Itching, hives, redness or a flare of an existing skin condition. Commonly reported alongside histamine-rich foods." },
  { id: "flushing", label: "Flushing", emoji: "😳", category: "Systemic", aliases: ["red face", "hot"],
    description:
      "Sudden warmth and redness, usually across the face, neck or chest." },
  { id: "palpitations", label: "Palpitations", emoji: "💓", category: "Systemic", aliases: ["racing heart"],
    description:
      "Noticing your heartbeat — racing, thumping or skipping — when you normally would not." },
  { id: "joint_pain", label: "Joint pain", emoji: "🦴", category: "Systemic", aliases: ["achy joints"],
    description:
      "Aching or stiff joints, without an injury to explain it." },
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
