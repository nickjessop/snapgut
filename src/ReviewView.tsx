import { useEffect, useMemo, useState } from "react";
import { recognizeFood } from "./api";
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
import { tagFood, TRIGGER_LABELS } from "./fodmap";
import { addEntry, type Entry, type LoggedSymptom } from "./db";

interface Props {
  photo: Blob;
  onDone: () => void;
  onRetake: () => void;
}

export default function ReviewView({ photo, onDone, onRetake }: Props) {
  const photoUrl = useMemo(() => URL.createObjectURL(photo), [photo]);
  const [foods, setFoods] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, Severity>>(new Map());
  const [bristol, setBristol] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(photoUrl), [photoUrl]);

  useEffect(() => {
    let cancelled = false;
    setAnalyzing(true);
    setError(null);
    recognizeFood(photo)
      .then((detected) => !cancelled && setFoods(detected))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setAnalyzing(false));
    return () => {
      cancelled = true;
    };
  }, [photo]);

  function removeFood(name: string) {
    setFoods((f) => f.filter((x) => x !== name));
  }
  function addFood() {
    const name = window.prompt("Add a food")?.trim();
    if (name) setFoods((f) => [...f, name]);
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
      if (selected.has(s.id)) continue; // selected shown separately
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
      foods,
      symptoms,
      bristol: bristol ?? undefined,
      photo,
    };
    await addEntry(entry);
    onDone();
  }

  return (
    <div className="sheet">
      <img className="thumb" src={photoUrl} alt="Your meal" />

      {/* ---- Foods ---- */}
      <div>
        <p className="section-title">What you ate</p>
        {analyzing ? (
          <p className="status">Analyzing your meal…</p>
        ) : (
          <div className="foods">
            {foods.map((f) => {
              const tags = tagFood(f);
              return (
                <button key={f} className="chip selected" onClick={() => removeFood(f)}>
                  {f}
                  {tags.length > 0 && (
                    <span className="fodmap-dot" title={tags.map((t) => TRIGGER_LABELS[t]).join(", ")}>
                      {TRIGGER_LABELS[tags[0]]}
                      {tags.length > 1 ? ` +${tags.length - 1}` : ""}
                    </span>
                  )}
                  <span className="x">×</span>
                </button>
              );
            })}
            <button className="chip add-food" onClick={addFood}>
              + Add
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            Couldn't auto-detect food. Add it manually.
          </div>
        )}
      </div>

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
      <button className="primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save log"}
      </button>
    </div>
  );
}
