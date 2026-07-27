import { useMemo, useState } from "react";
import {
  SYMPTOMS,
  CATEGORY_ORDER,
  searchSymptoms,
  getSymptom,
  SEVERITIES,
  type Severity,
  type SymptomCategory,
} from "./symptoms";

interface Props {
  selected: Map<string, Severity>;
  onChange: (next: Map<string, Severity>) => void;
}

/** Searchable, horizontally-scrolling symptom picker with per-symptom severity. */
export default function SymptomPicker({ selected, onChange }: Props) {
  const [query, setQuery] = useState("");

  function toggle(id: string) {
    const next = new Map(selected);
    if (next.has(id)) next.delete(id);
    else next.set(id, "moderate");
    onChange(next);
  }
  function setSeverity(id: string, sev: Severity) {
    onChange(new Map(selected).set(id, sev));
  }

  const results = useMemo(() => searchSymptoms(query), [query]);
  const byCategory = useMemo(() => {
    const map = new Map<SymptomCategory, typeof SYMPTOMS>();
    for (const s of results) {
      if (selected.has(s.id)) continue;
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return map;
  }, [results, selected]);

  return (
    <div>
      {selected.size > 0 && (
        <div className="selected-symptoms">
          {[...selected.entries()].map(([id, sev]) => {
            const s = getSymptom(id)!;
            return (
              <div key={id} className="sel-row">
                <button className="sel-chip" onClick={() => toggle(id)}>
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
        const items = byCategory.get(cat);
        if (!items || items.length === 0) return null;
        return (
          <div key={cat} className="cat-row">
            <div className="cat-label">{cat}</div>
            <div className="hscroll">
              {items.map((s) => (
                <button key={s.id} className="chip" onClick={() => toggle(s.id)}>
                  <span>{s.emoji}</span> {s.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
