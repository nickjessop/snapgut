import { useState } from "react";
import { putEvent, type LogEvent, type MealEvent } from "./db";
import { unconfirmedMeals } from "./mealOutcome";
import OutcomeToggle from "./OutcomeToggle";

/**
 * The meals the analysis had to leave out, offered for a one-tap answer.
 *
 * These are meals whose symptom window has closed with nothing reported, and where
 * there is no sign anyone was at the app to report it — so the quiet cannot be read
 * either way (mealOutcome.ts). Left alone they are simply absent from every rate.
 * Answered, they become the strongest form of evidence a food can have in its favour.
 *
 * Placed in Insights rather than on the timeline on purpose. This is where the payoff
 * is visible — the ask and the reason for the ask are on the same screen — and the
 * timeline stays a record of what happened rather than a list of chores.
 *
 * Nothing here is final. A confirmed row stays put with its answer showing so it can be
 * undone on the spot, and the same control lives on the meal's edit screen afterwards.
 */
export default function ConfirmOutcomes({
  events,
  onChanged,
}: {
  events: LogEvent[];
  onChanged: () => void;
}) {
  /**
   * Frozen on mount. Answering a meal would otherwise remove it from
   * `unconfirmedMeals` mid-interaction, so the row would vanish under the finger that
   * just tapped it and take the undo with it.
   */
  const [queue] = useState<MealEvent[]>(() => unconfirmedMeals(events));
  /** Answers given in this session, so a row can show its state and be reversed. */
  const [answers, setAnswers] = useState<Record<string, "fine" | undefined>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || queue.length === 0) return null;

  async function answer(meal: MealEvent, next: "fine" | undefined) {
    setBusy(meal.id);
    try {
      // The whole record is rewritten, so the stored meal is the base. Clearing removes
      // the key rather than setting it to `undefined`: IndexedDB keeps such a key, and
      // "not stated" should look identical to a meal logged before the field existed.
      const { outcome: _drop, ...rest } = meal;
      await putEvent(next ? { ...rest, outcome: next } : rest);
      setAnswers((a) => ({ ...a, [meal.id]: next }));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="confirm-outcomes" aria-labelledby="confirm-outcomes-title">
      <div className="confirm-outcomes-head">
        <h2 id="confirm-outcomes-title">How did these sit?</h2>
        <button
          className="confirm-outcomes-close"
          onClick={() => setDismissed(true)}
          aria-label="Hide this for now"
        >
          Not now
        </button>
      </div>
      <p className="hint">
        {queue.length === 1 ? "This meal" : `These ${queue.length} meals`} passed without
        a symptom logged, but nothing was logged afterwards either — so we left{" "}
        {queue.length === 1 ? "it" : "them"} out rather than assume{" "}
        {queue.length === 1 ? "it" : "they"} went fine. A tap makes{" "}
        {queue.length === 1 ? "it" : "them"} count.
      </p>
      <ul className="confirm-list">
        {queue.map((meal) => (
          <li key={meal.id} className="confirm-row">
            <div className="confirm-meal">
              <span className="confirm-dish">{meal.dish || "Meal"}</span>
              <span className="confirm-when">
                {new Date(meal.createdAt).toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </span>
            </div>
            <OutcomeToggle
              compact
              value={answers[meal.id] ?? meal.outcome}
              onChange={(next) => {
                if (busy) return;
                answer(meal, next);
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
