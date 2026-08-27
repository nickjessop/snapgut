import { useEffect, useState } from "react";
import { recognizeMeal, AuthError } from "./api";
import WhenPicker from "./WhenPicker";
import OutcomeToggle from "./OutcomeToggle";
import { putEvent, type Ingredient, type MealEvent } from "./db";
import { NoteIcon, AddIcon } from "./icons";
import BackButton from "./BackButton";

interface Props {
  /**
   * Absent when the meal is logged without a photo — something already eaten, or
   * a visitor who chose not to take one. With no image there is nothing for AI to
   * read, so the screen opens in manual mode.
   */
  photo: Blob | null;
  initialNote?: string;
  editing?: MealEvent;
  /** Whether a session is held. Recognition needs one, so an anonymous visitor
   *  must be offered sign-in rather than have a request fired on their behalf. */
  authed?: boolean;
  onSaved: () => void;
  onBack: () => void;
  onNeedSignIn?: () => void;
  onSignedOut?: () => void;
  /** Go back and attach a photo after starting a photo-less meal. */
  onAddPhoto?: () => void;
}

/**
 * Screen 2 of the meal flow: AI-derived dish + ingredients. The photo is a small
 * thumbnail at the bottom (tap to enlarge). The context note stays editable, and
 * changing it lets you re-analyze.
 */
export default function MealDetails({
  photo,
  initialNote = "",
  editing,
  authed = true,
  onSaved,
  onBack,
  onNeedSignIn,
  onSignedOut,
  onAddPhoto,
}: Props) {
  // No photo, no recognition — there is nothing to send.
  const canUseAi = authed && photo !== null;
  const [photoUrl, setPhotoUrl] = useState("");
  const [dish, setDish] = useState(editing?.dish ?? "");
  const [ingredients, setIngredients] = useState<Ingredient[]>(editing?.ingredients ?? []);
  const [note, setNote] = useState(editing?.note ?? initialNote);
  const [analyzedNote, setAnalyzedNote] = useState(editing?.note ?? initialNote);
  const [analyzing, setAnalyzing] = useState(!editing && canUseAi);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [when, setWhen] = useState<number>(editing?.createdAt ?? Date.now());
  const [outcome, setOutcome] = useState<"fine" | undefined>(editing?.outcome);

  useEffect(() => {
    if (!photo) {
      setPhotoUrl("");
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function analyze(withNote: string) {
    if (!photo) return;
    setAnalyzing(true);
    setError(null);
    try {
      const meal = await recognizeMeal(photo, withNote || undefined);
      setDish(meal.dish);
      setIngredients(meal.ingredients);
      setAnalyzedNote(withNote);
    } catch (e) {
      if (e instanceof AuthError) {
        onSignedOut?.();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setAnalyzing(false);
    }
  }

  useEffect(() => {
    if (!editing && canUseAi) analyze(initialNote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confident = ingredients.filter((i) => i.confidence === "confident");
  const maybe = ingredients.filter((i) => i.confidence === "maybe");
  const noteChanged = note.trim() !== analyzedNote.trim();

  const removeIngredient = (name: string) =>
    setIngredients((list) => list.filter((i) => i.name !== name));
  const promote = (name: string) =>
    setIngredients((list) =>
      list.map((i) => (i.name === name ? { ...i, confidence: "confident" } : i))
    );
  function addIngredient() {
    const name = window.prompt("Add an ingredient")?.trim();
    if (name) setIngredients((list) => [...list, { name, confidence: "confident" }]);
  }

  async function save() {
    setSaving(true);
    const event: Omit<MealEvent, "updatedAt"> = {
      id: editing?.id ?? crypto.randomUUID(),
      type: "meal",
      createdAt: when,
      dish: dish || "Meal",
      ingredients,
      note: note.trim() || undefined,
      ...(outcome ? { outcome } : {}),
      photo: photo ?? (editing?.photo || undefined),
    };
    await putEvent(event);
    onSaved();
  }

  return (
    <div className="sheet">
      <div className="log-header">
        <BackButton
          onClick={onBack}
          label={editing ? "Back, without saving these changes" : "Back"}
        />
        <span className="log-title">{editing ? "Edit meal" : "Meal details"}</span>
        <span style={{ width: 40 }} />
      </div>

      {/* Context note (editable) */}
      {editingNote ? (
        <div className="note-editor">
          <textarea
            autoFocus
            className="search"
            rows={2}
            placeholder="Add context…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 10 }}>
            <button className="link-btn" onClick={() => setEditingNote(false)}>
              Done
            </button>
            {noteChanged && canUseAi && (
              <button
                className="chip selected"
                onClick={() => {
                  setEditingNote(false);
                  analyze(note.trim());
                }}
              >
                Re-analyze with context
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="note-caption" onClick={() => setEditingNote(true)}>
          {note ? (
            <><NoteIcon size={14} /> {note}</>
          ) : (
            <><AddIcon size={14} /> Add context</>
          )}
        </div>
      )}

      {analyzing ? (
        <p className="status">Analyzing your meal…</p>
      ) : (
        <>
          {/* No AI on a new meal without a session: offer sign-in */}
          {!canUseAi && !editing && photo !== null && !authed && (
            <div className="ai-lock">
              <div className="ai-lock-title">
                Ingredients are yours to fill in
              </div>
              <p className="ai-lock-sub">
                Name the dish and add its ingredients below — logging is free and
                stays on your device. Want the photo read for you? Sign in to use AI.
              </p>
              <button className="primary" onClick={() => onNeedSignIn?.()}>
                Sign in to use AI
              </button>
            </div>
          )}

          <input
            className="dish-input"
            value={dish}
            placeholder="Dish name"
            onChange={(e) => setDish(e.target.value)}
          />

          <div>
            <p className="section-title">Ingredients</p>
            <div className="foods">
              {confident.map((i) => (
                <button key={i.name} className="chip selected" onClick={() => removeIngredient(i.name)}>
                  {i.name} <span className="x">×</span>
                </button>
              ))}
              <button className="chip add-food" onClick={addIngredient}>
                + Add
              </button>
            </div>
          </div>

          <WhenPicker onChange={setWhen} initial={when} />

          {editing && (
            <div>
              <p className="section-title">How it sat</p>
              <OutcomeToggle value={outcome} onChange={setOutcome} />
              <p className="hint">
                A meal that passed without symptoms counts in its ingredients' favour.
                Saying so is stronger evidence than us assuming it from a quiet day —
                and you can change or clear this any time.
              </p>
            </div>
          )}

          {maybe.length > 0 && (
            <div>
              <p className="section-title">Maybe also (tap to confirm)</p>
              <div className="foods">
                {maybe.map((i) => (
                  <button key={i.name} className="chip maybe" onClick={() => promote(i.name)}>
                    {i.name}
                    <span
                      className="x"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeIngredient(i.name);
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="error-banner">
              Couldn't auto-detect the meal. Add ingredients manually.
            </div>
          )}
        </>
      )}

      <div className="spacer" />

      {photoUrl && (
        <img
          className="mini-photo"
          src={photoUrl}
          alt="Meal"
          onClick={() => setEnlarged(true)}
        />
      )}
      {!photo && !editing && (
        <button className="link-btn" onClick={() => onAddPhoto?.()}>
          Add a photo instead
        </button>
      )}

      <button className="primary" disabled={saving || analyzing} onClick={save}>
        {saving ? "Saving…" : editing ? "Update" : "Save meal"}
      </button>

      {enlarged && (
        <div className="photo-overlay" onClick={() => setEnlarged(false)}>
          <img src={photoUrl} alt="Meal enlarged" />
        </div>
      )}
    </div>
  );
}
