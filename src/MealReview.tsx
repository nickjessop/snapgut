import { useEffect, useMemo, useState } from "react";
import { recognizeMeal } from "./api";
import { addEvent, type Ingredient, type MealEvent } from "./db";

interface Props {
  photo: Blob;
  editing?: MealEvent;
  onDone: () => void;
  onRetake: () => void;
}

export default function MealReview({ photo, editing, onDone, onRetake }: Props) {
  const photoUrl = useMemo(() => URL.createObjectURL(photo), [photo]);
  const [dish, setDish] = useState(editing?.dish ?? "");
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    editing?.ingredients ?? []
  );
  const [analyzing, setAnalyzing] = useState(!editing);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState(editing?.note ?? "");
  const [editingNote, setEditingNote] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(photoUrl), [photoUrl]);

  async function analyze(withNote?: string) {
    setAnalyzing(true);
    setError(null);
    try {
      const meal = await recognizeMeal(photo, withNote);
      setDish(meal.dish);
      setIngredients(meal.ingredients);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  useEffect(() => {
    if (!editing) analyze(); // don't re-run AI when editing an existing meal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confident = ingredients.filter((i) => i.confidence === "confident");
  const maybe = ingredients.filter((i) => i.confidence === "maybe");

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
  function submitNote() {
    setEditingNote(false);
    if (note.trim()) analyze(note.trim());
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
    onDone();
  }

  return (
    <div className="sheet">
      <div className="log-header">
        <button className="link-btn" onClick={onRetake}>
          {editing ? "Cancel" : "‹ Retake"}
        </button>
        <span className="log-title">{editing ? "Edit meal" : "Log a meal"}</span>
        <span style={{ width: 60 }} />
      </div>

      <div className="photo-wrap" onClick={() => setEditingNote(true)}>
        <img className="thumb" src={photoUrl} alt="Your meal" />
        {!note && !editingNote && <div className="tap-hint">Tap to add context</div>}
      </div>

      {editingNote ? (
        <div className="note-editor">
          <textarea
            autoFocus
            className="search"
            rows={2}
            placeholder="e.g. from an instant ramen pack, cooked in butter…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 10 }}>
            <button className="link-btn" onClick={() => setEditingNote(false)}>
              Cancel
            </button>
            <button className="chip selected" onClick={submitNote}>
              Re-analyze with context
            </button>
          </div>
        </div>
      ) : (
        note && (
          <div className="note-caption" onClick={() => setEditingNote(true)}>
            📝 {note}
          </div>
        )
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
      <button className="primary" disabled={saving || analyzing} onClick={save}>
        {saving ? "Saving…" : "Save meal"}
      </button>
    </div>
  );
}
