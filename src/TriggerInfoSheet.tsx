import { infoForLabel } from "./triggerInfo";

interface Props {
  /** The displayed trigger label, e.g. "Fructans". */
  label: string;
  onClose: () => void;
}

/**
 * What a trigger group is, opened by tapping the one named in a pattern row.
 *
 * A sheet rather than an inline expansion, because the Patterns list is already
 * dense and an accordion inside it would push the rows below out from under the
 * reader's finger.
 *
 * The closing line is not filler. Group membership is coarse — the dictionary where
 * it exists, keyword matching otherwise — and a screen that explains fructans in
 * confident prose invites more trust in the tagging than it has earned.
 */
export default function TriggerInfoSheet({ label, onClose }: Props) {
  const info = infoForLabel(label);
  if (!info) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="action-sheet trigger-info"
        role="dialog"
        aria-modal="true"
        aria-label={info.label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-grip" />

        <div className="ti-head">
          <div className="ti-title">{info.label}</div>
          {info.isFodmap && <span className="ti-tag">FODMAP group</span>}
        </div>

        <p className="ti-summary">{info.summary}</p>

        <p className="ti-label">Commonly found in</p>
        <p className="ti-body">{info.found}</p>

        <p className="ti-label">Why it can show up beside symptoms</p>
        <p className="ti-body">{info.why}</p>

        <p className="ti-caveat">
          We group foods by name, using a food dictionary where we have one and keyword
          matching where we don't, so the tagging is approximate — "almond milk" can be
          read as milk. Seeing a group here means it appeared near your symptoms often
          enough to be worth noticing, not that it is a cause. Talk to a clinician
          before cutting a food group out.
        </p>

        <button className="action-cancel" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
