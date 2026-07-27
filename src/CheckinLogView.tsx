import { useState } from "react";
import WhenPicker from "./WhenPicker";
import {
  addEvent,
  type CheckinEvent,
  type StressLevel,
  type SleepQuality,
} from "./db";

interface Props {
  editing?: CheckinEvent;
  onDone: () => void;
  onCancel: () => void;
}

const STRESS: { value: StressLevel; label: string; emoji: string }[] = [
  { value: "low", label: "Low", emoji: "😌" },
  { value: "medium", label: "Medium", emoji: "😕" },
  { value: "high", label: "High", emoji: "😰" },
];

const SLEEP: { value: SleepQuality; label: string; emoji: string }[] = [
  { value: "poor", label: "Poor", emoji: "🥱" },
  { value: "ok", label: "OK", emoji: "😐" },
  { value: "good", label: "Good", emoji: "😴" },
];

export default function CheckinLogView({ editing, onDone, onCancel }: Props) {
  const [stress, setStress] = useState<StressLevel | null>(editing?.stress ?? null);
  const [sleep, setSleep] = useState<SleepQuality | null>(editing?.sleep ?? null);
  const [when, setWhen] = useState<number>(editing?.createdAt ?? Date.now());
  const [note, setNote] = useState(editing?.note ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!stress && !sleep) return;
    setSaving(true);
    const event: CheckinEvent = {
      id: editing?.id ?? crypto.randomUUID(),
      type: "checkin",
      createdAt: editing ? editing.createdAt : when,
      stress: stress ?? undefined,
      sleep: sleep ?? undefined,
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
        <span className="log-title">Stress & sleep</span>
        <span style={{ width: 60 }} />
      </div>

      <div>
        <p className="section-title">Stress right now</p>
        <div className="hscroll">
          {STRESS.map((s) => (
            <button
              key={s.value}
              className={`chip${stress === s.value ? " selected" : ""}`}
              onClick={() => setStress(stress === s.value ? null : s.value)}
            >
              <span>{s.emoji}</span> {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="section-title">Last night's sleep</p>
        <div className="hscroll">
          {SLEEP.map((s) => (
            <button
              key={s.value}
              className={`chip${sleep === s.value ? " selected" : ""}`}
              onClick={() => setSleep(sleep === s.value ? null : s.value)}
            >
              <span>{s.emoji}</span> {s.label}
            </button>
          ))}
        </div>
      </div>

      {!editing && <WhenPicker onChange={setWhen} />}

      <div>
        <p className="section-title">Note (optional)</p>
        <textarea
          className="search"
          rows={2}
          placeholder="Work deadline, travel, etc."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="spacer" />
      <button className="primary" disabled={saving || (!stress && !sleep)} onClick={save}>
        {saving ? "Saving…" : editing ? "Update" : "Save check-in"}
      </button>
    </div>
  );
}
