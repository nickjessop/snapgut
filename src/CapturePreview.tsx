import { useEffect, useState } from "react";
import { BackIcon } from "./icons";

interface Props {
  photo: Blob;
  initialNote?: string;
  onProceed: (note: string) => void;
  onRetake: () => void;
}

/**
 * Screen 1 of the meal flow (Snapchat-style): the full photo with an optional
 * context caption, and a Next button. The caption is passed into AI analysis on
 * the next screen so it can infer hidden ingredients.
 */
export default function CapturePreview({ photo, initialNote = "", onProceed, onRetake }: Props) {
  const [photoUrl, setPhotoUrl] = useState("");
  const [note, setNote] = useState(initialNote);

  useEffect(() => {
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  return (
    <div className="capture">
      <img className="capture-img" src={photoUrl} alt="Your meal" />

      {/* A chevron rather than an X, matching every other back control. It does
          discard the photo, so the label says so — the glyph alone should not have
          to carry that. */}
      <button
        className="circle-btn capture-close"
        onClick={onRetake}
        aria-label="Back to the camera, discarding this photo"
      >
        <BackIcon size={24} />
      </button>

      <div className="capture-bottom">
        <textarea
          className="caption-input"
          rows={2}
          placeholder="Add context… e.g. from an instant ramen pack, cooked in butter"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="primary" onClick={() => onProceed(note.trim())}>
          Next
        </button>
      </div>
    </div>
  );
}
