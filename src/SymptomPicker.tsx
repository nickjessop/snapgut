import { useMemo, useState } from "react";
import {
  SYMPTOMS,
  CATEGORY_ORDER,
  searchSymptoms,
  type Severity,
  type SymptomCategory,
} from "./symptoms";
import SymptomDetailSheet from "./SymptomDetailSheet";
import useLongPress from "./useLongPress";
import { CloseIcon } from "./icons";

/** Set once the long-press hint has been dismissed, so it is shown once per device. */
const HINT_KEY = "food-snap-symptom-hold-hint";

/** Short badge for a severity. Three letters, so mild and moderate cannot be confused. */
const SEVERITY_BADGE: Record<Severity, string> = {
  mild: "MLD",
  moderate: "MOD",
  severe: "SEV",
};

interface Props {
  selected: Map<string, Severity>;
  onChange: (next: Map<string, Severity>) => void;
}

/**
 * Searchable symptom grid with selection and severity in place.
 *
 * Selected symptoms used to be lifted out into a second list above the grid, each with
 * its own row of severity buttons. That had two costs: a symptom moved the moment you
 * picked it, so the thing you just tapped was no longer where you tapped it, and every
 * selection permanently claimed a row of screen. Now a chip stays exactly where it is
 * and shows its own state, and severity lives behind a hold.
 */
export default function SymptomPicker({ selected, onChange }: Props) {
  const [query, setQuery] = useState("");
  /** The symptom whose detail sheet is open, if any. */
  const [detail, setDetail] = useState<string | null>(null);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      // No storage means no memory of a dismissal, and a hint that cannot be
      // dismissed for good is worse than no hint.
      return true;
    }
  });

  function toggle(id: string) {
    const next = new Map(selected);
    if (next.has(id)) next.delete(id);
    else next.set(id, "moderate");
    onChange(next);
  }

  function setSeverity(id: string, sev: Severity) {
    onChange(new Map(selected).set(id, sev));
  }

  function remove(id: string) {
    const next = new Map(selected);
    next.delete(id);
    onChange(next);
    setDetail(null);
  }

  function dismissHint() {
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* nothing to remember it with; the session-level state still applies */
    }
    setHintDismissed(true);
  }

  const results = useMemo(() => searchSymptoms(query), [query]);
  const byCategory = useMemo(() => {
    const map = new Map<SymptomCategory, typeof SYMPTOMS>();
    for (const s of results) {
      // Selected symptoms stay in their own category rather than being filtered out —
      // that filtering is what used to make a chip vanish from under your finger.
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return map;
  }, [results]);

  return (
    <div>
      <input
        className="search"
        placeholder="Search symptoms (bloating, cramps, reflux…)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {/* Shown until dismissed, because a hold is not a gesture anyone will find on
          their own. Dismissal is remembered, so it appears once and not every log. */}
      {!hintDismissed && (
        <div className="hold-hint">
          <span>Hold a symptom to set how bad it was, or read what it covers.</span>
          <button className="hold-hint-x" onClick={dismissHint} aria-label="Dismiss hint">
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const items = byCategory.get(cat);
        if (!items || items.length === 0) return null;
        return (
          <div key={cat} className="cat-row">
            <div className="cat-label">{cat}</div>
            <div className="hscroll">
              {items.map((s) => (
                <SymptomChip
                  key={s.id}
                  emoji={s.emoji}
                  label={s.label}
                  severity={selected.get(s.id) ?? null}
                  onTap={() => toggle(s.id)}
                  onHold={() => setDetail(s.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {detail && (
        <SymptomDetailSheet
          symptomId={detail}
          severity={selected.get(detail) ?? null}
          onPick={(sev) => setSeverity(detail, sev)}
          onRemove={() => remove(detail)}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function SymptomChip({
  emoji,
  label,
  severity,
  onTap,
  onHold,
}: {
  emoji: string;
  label: string;
  severity: Severity | null;
  onTap: () => void;
  onHold: () => void;
}) {
  const press = useLongPress(onHold, onTap);
  const on = severity !== null;

  return (
    <button
      className={`chip symptom-chip${on ? " selected" : ""}`}
      aria-pressed={on}
      // Spelled out rather than left to the badge, which is an abbreviation a screen
      // reader would read as letters.
      aria-label={on ? `${label}, ${severity}` : label}
      {...press}
    >
      <span aria-hidden="true">{emoji}</span> {label}
      {on && (
        <span className={`sev-badge ${severity}`} aria-hidden="true">
          {SEVERITY_BADGE[severity]}
        </span>
      )}
    </button>
  );
}
