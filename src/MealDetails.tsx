import { useEffect, useMemo, useState } from "react";
import { recognizeMeal } from "./api";
import { addEvent, type Ingredient, type MealEvent } from "./db";

interface Props {
  photo: Blob;
  initialNote?: string;
  editing?: MealEvent;
  onSaved: () => void;
  onBack: () => void;
}

/**
 * Screen 2 of the meal flow: AI-derived dish + ingredients. The photo is a small
 * thumbnail at the bottom (tap to enlarge). The context note stays editable, and
 * changing it lets you re-analyze.
 */
export default function MealDetails({ photo, initialNote = "", editing, onSaved, onBack }: Props) {
  const photoUrl = useMemo(() => URL.createObjectURL(photo), [photo]);
  const [dish, setDish] = useState(editing?.dish ?? "");
  const [ingredients, setIngredients] = useState<Ingredient[]>(editing?.ingredients ?? []);
  const [note, setNote] = useState(editing?.note ?? initialNote);
  const [analyzedNote, setAnalyzedNote] = useState(editing?.note ?? initialNote);
  const [analyzing, setAnalyzing] = useState(!editing);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [editingNote, setEditingNote] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(photoUrl), [photoUrl]);

  async function analyze(withNote: string) {
    setAnalyzing(true);
    setError(null);
    try {
      const meal = await recognizeMeal(photo, withNote || undefined);
      setDish(meal.dish);
      setIngredients(meal.ingredients);
      setAnalyzedNote(withNote);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  useEffect(() => {
    if (!editing) analyze(initialNote);
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
    const event: MealEvent = {
      id: editing?.id ?? crypto.randomUUID(),
      type: "meal",
      createdAt: editing?.createdAt ?? Date.now(),
      dish: dish || "Meal",
      ingredients,
      note: note.trim() || undefined,
      photo,
    };
    await addEvent(event);
    onSaved();
  }

  return (
    <div className="sheet">
      <div className="log-header">
        <button className="link-btn" onClick={onBack}>
          {editing ? "Cancel" : "‹ Back"}
        </button>
        <span className="log-title">{editing ? "Edit meal" : "Meal details"}</span>
        <span style={{ width: 60 }} />
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
            {noteChanged && (
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
          {note ? `📝 ${note}` : "＋ Add context"}
        </div>
      )}

      {analyzing ? (
        <p className="status">Analyzing your meal…</p>
      ) : (
        <>
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

      {/* Small photo thumbnail — tap to enlarge */}
      <div className="mini-photo-row">
        <img
          className="mini-photo"
          src={photoUrl}
          alt="Meal"
          onClick={() => setEnlarged(true)}
        />
        <span className="mini-hint">Tap photo to enlarge</span>
      </div>

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
