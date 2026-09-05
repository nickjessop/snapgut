export interface Mood {
  label: string;
  emoji: string;
}

// One-tap mood chips shown after logging a meal.
export const MOODS: Mood[] = [
  { label: "Great", emoji: "😃" },
  { label: "Good", emoji: "🙂" },
  { label: "Meh", emoji: "😐" },
  { label: "Full", emoji: "😮‍💨" },
  { label: "Bloated", emoji: "🫃" },
  { label: "Sluggish", emoji: "😴" },
  { label: "Energized", emoji: "⚡️" },
  { label: "Guilty", emoji: "😬" },
  { label: "Sick", emoji: "🤢" },
];
