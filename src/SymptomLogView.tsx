import { useState } from "react";
import SymptomPicker from "./SymptomPicker";
import WhenPicker from "./WhenPicker";
import { addEvent, type LoggedSymptom, type SymptomEvent } from "./db";
import type { Severity } from "./symptoms";

interface Props {
  onDone: () => void;
  onCancel: () => void;
}

export default function SymptomLogView({ onDone, onCancel }: Props) {
  const [selected, setSelected] = useState<Map<string, Severity>>(new Map());
  const [when, setWhen] = useState<number>(Date.now());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const symptoms: LoggedSymptom[] = [...selected.entries()].map(([id, severity]) => ({
      id,
      severity,
    }));
    const event: SymptomEvent = {
      id: crypto.randomUUID(),
      type: "symptom",
      createdAt: when,
      symptoms,
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
        <span className="log-title">How's your gut?</span>
        <span style={{ width: 60 }} />
      </div>

      <SymptomPicker selected={selected} onChange={setSelected} />

      <WhenPicker onChange={setWhen} />

      <div>
        <p className="section-title">Note (optional)</p>
        <textarea
          className="search"
          rows={2}
          placeholder="Anything else? stress, travel, meds…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="spacer" />
      <button className="primary" disabled={saving || selected.size === 0} onClick={save}>
        {saving ? "Saving…" : "Save symptoms"}
      </button>
    </div>
  );
}
