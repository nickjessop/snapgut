import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, HelpIcon, InfoIcon } from "./icons";

interface InfoNoteProps {
  /** The one-line disclaimer. Kept short — the long form belongs in the modal. */
  children: ReactNode;
  /** Heading of the explainer modal. */
  title: string;
  /** The full explanation. Paragraphs, not a sentence fragment. */
  explanation: ReactNode;
  /** Tooltip on the help affordance. */
  hint?: string;
}

/**
 * An info-style notice with a help affordance that opens a fuller explanation.
 *
 * The disclaimers the Log and Insights screens have to carry are the kind of copy
 * people stop reading when it arrives as a paragraph of small grey text. So the
 * short form is the whole notice, and the detail is one tap away rather than
 * always on screen.
 *
 * The sheet reuses the app's existing `.sheet-backdrop` / `.action-sheet`
 * treatment so it looks like every other tray, but unlike the hand-rolled ones it
 * is labelled as a dialog and closes on Escape.
 */
export default function InfoNote({
  children,
  title,
  explanation,
  hint = "What does this mean?",
}: InfoNoteProps) {
  const [open, setOpen] = useState(false);

  // The sheet is a *sibling* of the note, not a child. `.info-note` animates in
  // with a transform, and a transformed element becomes the containing block for
  // its `position: fixed` descendants — nested, the backdrop would size itself to
  // the note instead of covering the viewport.
  return (
    <>
      <div className="info-note">
        <span className="info-note-ico" aria-hidden="true">
          <InfoIcon size={17} />
        </span>
        <p className="info-note-text">{children}</p>
        <button
          className="info-note-more"
          onClick={() => setOpen(true)}
          title={hint}
          aria-haspopup="dialog"
          aria-label={`${title} — ${hint}`}
        >
          <HelpIcon size={15} />
        </button>
      </div>

      {open && (
        <InfoSheet title={title} onClose={() => setOpen(false)}>
          {explanation}
        </InfoSheet>
      )}
    </>
  );
}

function InfoSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus starts inside the sheet so a keyboard or screen
  // reader user is not left behind on the trigger under the backdrop.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="action-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-grip" />
        <div className="info-title" id={headingId}>
          <InfoIcon size={20} />
          {title}
        </div>
        <div className="info-copy">{children}</div>
        <button className="action-cancel" ref={closeRef} onClick={onClose}>
          <CheckIcon size={17} />
          Got it
        </button>
      </div>
    </div>
  );
}
