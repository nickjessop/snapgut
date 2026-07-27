import { useEffect, useMemo, useState } from "react";
import { recognizeMeal } from "./api";
import {
  SYMPTOMS,
  CATEGORY_ORDER,
  searchSymptoms,
  getSymptom,
  SEVERITIES,
  BRISTOL,
  type Severity,
  type SymptomCategory,
} from "./symptoms";
import { addEntry, type Entry, type Ingredient, type LoggedSymptom } from "./db";

interface Props {
  photo: Blob;
  onDone: () => void;
  onRetake: () => void;
}

export default function ReviewView({ photo, onDone, onRetake }: Props) {
  const photoUrl = useMemo(() => URL.createObjectURL(photo), [photo]);
  const [dish, setDish] = useState("");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [analyzing, setAnalyzing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [editingNote, setEditingNote] = useState(false);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, Severity>>(new Map());
  const [bristol, setBristol] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(photoUrl), [photoUrl]);

  // Analyze on mount (and expose a callable for re-analysis with a note).
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
    analyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confident = ingredients.filter((i) => i.confidence === "confident");
  const maybe = ingredients.filter((i) => i.confidence === "maybe");

  function removeIngredient(name: string) {
    setIngredients((list) => list.filter((i) => i.name !== name));
  }
  function promote(name: string) {
    setIngredients((list) =>
      list.map((i) => (i.name === name ? { ...i, confidence: "confident" } : i))
    );
  }
  function addIngredient() {
    const name = window.prompt("Add an ingredient")?.trim();
    if (name) setIngredients((list) => [...list, { name, confidence: "confident" }]);
  }

  function submitNote() {
    setEditingNote(false);
    if (note.trim()) analyze(note.trim());
  }

  function toggleSymptom(id: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, "moderate");
      return next;
    });
  }
  function setSeverity(id: string, sev: Severity) {
    setSelected((prev) => new Map(prev).set(id, sev));
  }

  const searchResults = useMemo(() => searchSymptoms(query), [query]);
  const resultsByCategory = useMemo(() => {
    const map = new Map<SymptomCategory, typeof SYMPTOMS>();
    for (const s of searchResults) {
      if (selected.has(s.id)) continue;
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return map;
  }, [searchResults, selected]);

  async function save() {
    setSaving(true);
    const symptoms: LoggedSymptom[] = [...selected.entries()].map(
      ([id, severity]) => ({ id, severity })
    );
    const entry: Entry = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      dish: dish || "Meal",
      ingredients,
      note: note.trim() || undefined,
      symptoms,
      bristol: bristol ?? undefined,
      photo,
    };
    await addEntry(entry);
    onDone();
  }

  return (
    <div className="sheet">
      {/* ---- Photo (tap to add context) ---- */}
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

      {/* ---- Dish + ingredients ---- */}
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
                <button
                  key={i.name}
                  className="chip selected"
                  onClick={() => removeIngredient(i.name)}
                >
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
                  <button
                    key={i.name}
                    className="chip maybe"
                    onClick={() => promote(i.name)}
                  >
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

      {/* ---- Symptoms ---- */}
      <div>
        <p className="section-title">How's your gut?</p>

        {selected.size > 0 && (
          <div className="selected-symptoms">
            {[...selected.entries()].map(([id, sev]) => {
              const s = getSymptom(id)!;
              return (
                <div key={id} className="sel-row">
                  <button className="sel-chip" onClick={() => toggleSymptom(id)}>
                    <span>{s.emoji}</span>
                    {s.label}
                    <span className="x">×</span>
                  </button>
                  <div className="severity">
                    {SEVERITIES.map((sv) => (
                      <button
                        key={sv.value}
                        className={`sev${sev === sv.value ? " on" : ""} ${sv.value}`}
                        onClick={() => setSeverity(id, sv.value)}
                      >
                        {sv.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <input
          className="search"
          placeholder="Search symptoms (bloating, cramps, reflux…)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {CATEGORY_ORDER.map((cat) => {
          const items = resultsByCategory.get(cat);
          if (!items || items.length === 0) return null;
          return (
            <div key={cat} className="cat-row">
              <div className="cat-label">{cat}</div>
              <div className="hscroll">
                {items.map((s) => (
                  <button key={s.id} className="chip" onClick={() => toggleSymptom(s.id)}>
                    <span>{s.emoji}</span> {s.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ---- Bowel movement (optional) ---- */}
      <div>
        <p className="section-title">Bowel movement? (optional)</p>
        <div className="hscroll">
          {BRISTOL.map((b) => (
            <button
              key={b.type}
              className={`chip bristol ${b.tendency}${bristol === b.type ? " selected" : ""}`}
              onClick={() => setBristol(bristol === b.type ? null : b.type)}
            >
              <span>{b.emoji}</span> {b.type} · {b.short}
            </button>
          ))}
        </div>
      </div>

      <div className="spacer" />

      <button className="link-btn" onClick={onRetake} style={{ alignSelf: "center" }}>
        Retake
      </button>
      <button className="primary" disabled={saving || analyzing} onClick={save}>
        {saving ? "Saving…" : "Save log"}
      </button>
    </div>
  );
}
