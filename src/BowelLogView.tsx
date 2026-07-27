import { useState } from "react";
import WhenPicker from "./WhenPicker";
import SymptomPicker from "./SymptomPicker";
import { BRISTOL } from "./symptoms";
import { addEvent, type BowelEvent, type LoggedSymptom } from "./db";
import type { Severity } from "./symptoms";

interface Props {
  editing?: BowelEvent;
  onDone: () => void;
  onCancel: () => void;
}

export default function BowelLogView({ editing, onDone, onCancel }: Props) {
  const [bristol, setBristol] = useState<number | null>(editing?.bristol ?? null);
  const [selected, setSelected] = useState<Map<string, Severity>>(
    () => new Map((editing?.symptoms ?? []).map((s) => [s.id, s.severity]))
  );
  const [when, setWhen] = useState<number>(editing?.createdAt ?? Date.now());
  const [note, setNote] = useState(editing?.note ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (bristol == null) return;
    setSaving(true);
    const symptoms: LoggedSymptom[] = [...selected.entries()].map(([id, severity]) => ({
      id,
      severity,
    }));
    const event: BowelEvent = {
      id: editing?.id ?? crypto.randomUUID(),
      type: "bowel",
      createdAt: editing ? editing.createdAt : when,
      bristol,
      symptoms: symptoms.length ? symptoms : undefined,
      note: note.trim() || undefined,
    };
    await addEvent(event);
    onDone();
  }

  return (
    <div className="sheet">
      <div className="log-header">
        <button className="link-btn" onClick={onCancel}>
          Cancel
        </button>
        <span className="log-title">Bowel movement</span>
        <span style={{ width: 60 }} />
      </div>

      <div>
        <p className="section-title">Consistency (Bristol scale)</p>
        <div className="bristol-grid">
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

      <div>
        <p className="section-title">Any symptoms with it? (optional)</p>
        <SymptomPicker selected={selected} onChange={setSelected} />
      </div>

      {!editing && <WhenPicker onChange={setWhen} />}

      <div>
        <p className="section-title">Note (optional)</p>
        <textarea
          className="search"
          rows={2}
          placeholder="Anything else?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="spacer" />
      <button className="primary" disabled={saving || bristol == null} onClick={save}>
        {saving ? "Saving…" : editing ? "Update" : "Save"}
      </button>
    </div>
  );
}
