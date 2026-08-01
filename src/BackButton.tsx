import { BackIcon } from "./icons";

interface Props {
  onClick: () => void;
  /**
   * What the control does, for assistive technology. The glyph is a bare chevron,
   * so the label is the only thing that distinguishes leaving a log from leaving
   * Settings — it should name the destination or the action, not just say "back".
   */
  label?: string;
}

/**
 * The single back affordance.
 *
 * Before this there were five: "Cancel" as text in three log flows, a chevron plus
 * the word "Back" in the meal flow, an X on the capture preview, and a bare chevron
 * in Settings — so the control for the same gesture moved, changed shape, and
 * changed wording depending on which screen you were on.
 *
 * "Cancel" was also the wrong word for most of them. It reads as *discard*, which
 * is what it does on a confirmation dialog, whereas leaving a half-filled log keeps
 * everything already saved. A chevron makes no such promise.
 *
 * Confirmation dialogs keep their textual "Cancel" deliberately: that is a choice
 * between two outcomes, not a navigation, and it needs a word.
 */
export default function BackButton({ onClick, label = "Back" }: Props) {
  return (
    <button className="back-btn" onClick={onClick} aria-label={label}>
      <BackIcon size={24} />
    </button>
  );
}
