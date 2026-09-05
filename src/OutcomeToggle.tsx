import { CheckIcon } from "./icons";

/**
 * "Did this sit okay?" — the user answering directly instead of the app inferring it
 * from silence.
 *
 * Always a toggle, never a commitment. Tapping a set answer clears it, and the control
 * appears on the meal's own edit screen as well as in the Insights prompt, so an
 * answer given in a hurry can be changed from wherever the meal is next seen. Nothing
 * here is one-way: `undefined` is a real, reachable state meaning "not stated", and it
 * is distinct from "fine" everywhere it matters (see MealEvent.outcome).
 *
 * There is deliberately no "felt bad" option. That is what logging a symptom is for,
 * and offering a second, vaguer way to say it would split the same evidence across two
 * shapes — one of which the analysis could not use.
 */
export default function OutcomeToggle({
  value,
  onChange,
  compact = false,
}: {
  value: "fine" | undefined;
  onChange: (next: "fine" | undefined) => void;
  /** Row form for the Insights prompt; the full form is used on the edit screen. */
  compact?: boolean;
}) {
  const set = value === "fine";
  const label = set ? "Sat fine — tap to undo" : "Mark this meal as having sat fine";

  return (
    <button
      type="button"
      className={`outcome-toggle${set ? " on" : ""}${compact ? " compact" : ""}`}
      aria-pressed={set}
      aria-label={label}
      title={label}
      onClick={() => onChange(set ? undefined : "fine")}
    >
      <span className="outcome-mark" aria-hidden="true">
        {set ? <CheckIcon size={15} /> : null}
      </span>
      <span className="outcome-text">{set ? "Sat fine" : "Sat fine?"}</span>
    </button>
  );
}
