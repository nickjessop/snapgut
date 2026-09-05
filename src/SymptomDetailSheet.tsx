import { useEffect, useRef } from "react";
import { SEVERITIES, getSymptom, type Severity } from "./symptoms";
import { CheckIcon } from "./icons";

interface Props {
  symptomId: string;
  /** The severity currently recorded, or `null` when not yet selected. */
  severity: Severity | null;
  /** Choose a severity. Selecting one also selects the symptom. */
  onPick: (severity: Severity) => void;
  /** Remove the symptom from this entry entirely. */
  onRemove: () => void;
  onClose: () => void;
}

/**
 * What a symptom means, and how bad it was — opened by holding a chip.
 *
 * Severity used to live in a second list above the picker, which meant every selected
 * symptom permanently occupied a row of screen whether or not you cared about its
 * severity. Putting it behind a hold keeps the grid intact and makes severity a
 * deliberate act rather than a form field to work through.
 *
 * The description is here rather than in a separate help screen because this is the
 * moment it is useful: deciding whether what you feel is bloating or distension,
 * cramping or an ache. A log is only worth analysing if the same feeling reaches the
 * same chip each time.
 */
export default function SymptomDetailSheet({
  symptomId,
  severity,
  onPick,
  onRemove,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const symptom = getSymptom(symptomId);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!symptom) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="action-sheet symptom-detail"
        role="dialog"
        aria-modal="true"
        aria-label={symptom.label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-grip" />

        <div className="sd-head">
          <span className="sd-emoji" aria-hidden="true">
            {symptom.emoji}
          </span>
          <span className="sd-title">{symptom.label}</span>
        </div>

        {symptom.description && <p className="sd-desc">{symptom.description}</p>}

        <p className="sd-label">How bad was it?</p>
        <div className="sd-severities">
          {SEVERITIES.map((sv) => (
            <button
              key={sv.value}
              className={`sd-sev ${sv.value}${severity === sv.value ? " on" : ""}`}
              aria-pressed={severity === sv.value}
              onClick={() => onPick(sv.value)}
            >
              {sv.label}
            </button>
          ))}
        </div>

        {/* Only offered once the symptom is actually on the entry — otherwise it would
            be a control that undoes nothing. */}
        {severity !== null && (
          <button className="link-btn sd-remove" onClick={onRemove}>
            Remove this symptom
          </button>
        )}

        <button className="action-cancel" ref={closeRef} onClick={onClose}>
          <CheckIcon size={17} />
          Done
        </button>
      </div>
    </div>
  );
}
