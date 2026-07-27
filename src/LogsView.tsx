import { useEffect, useMemo, useState } from "react";
import {
  getEvents,
  deleteEvent,
  toCSV,
  type LogEvent,
  type MealEvent,
} from "./db";
import { getSymptom, BRISTOL } from "./symptoms";

interface Props {
  onEdit: (event: LogEvent) => void;
  reloadKey: number; // bump to force a reload after edits elsewhere
}

export default function LogsView({ onEdit, reloadKey }: Props) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [detail, setDetail] = useState<LogEvent | null>(null);

  useEffect(() => {
    getEvents().then(setEvents);
  }, [reloadKey]);

  async function remove(id: string) {
    await deleteEvent(id);
    setEvents((list) => list.filter((e) => e.id !== id));
    setDetail(null);
  }

  async function exportCSV() {
    const csv = toCSV(events, (id) => getSymptom(id)?.label ?? id);
    const blob = new Blob([csv], { type: "text/csv" });
    const file = new File([blob], "food-snap.csv", { type: "text/csv" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: "Food Snap export" });
        return;
      } catch {
        /* fall through */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "food-snap.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const groups = useMemo(() => {
    const map = new Map<string, LogEvent[]>();
    for (const e of events) {
      const key = new Date(e.createdAt).toDateString();
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [events]);

  return (
    <div className="history">
      <div className="history-header">
        <h1>Timeline</h1>
        {events.length > 0 && (
          <button className="link-btn" onClick={exportCSV}>
            Export CSV
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <p className="empty">Nothing logged yet. Tap ＋ or snap a meal to start.</p>
      ) : (
        groups.map(([day, dayEvents]) => (
          <div key={day} className="day-group">
            <div className="day-label">{formatDay(day)}</div>
            {dayEvents.map((e) => (
              <TimelineRow key={e.id} event={e} onClick={() => setDetail(e)} />
            ))}
          </div>
        ))
      )}

      {detail && (
        <div className="sheet-backdrop" onClick={() => setDetail(null)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <div className="detail-title">{describe(detail)}</div>
            <button
              className="action-item"
              onClick={() => {
                const e = detail;
                setDetail(null);
                onEdit(e);
              }}
            >
              <span className="ai-ico">✏️</span>
              <div className="ai-title">Edit</div>
            </button>
            <button className="action-item danger" onClick={() => remove(detail.id)}>
              <span className="ai-ico">🗑️</span>
              <div className="ai-title">Delete</div>
            </button>
            <button className="action-cancel" onClick={() => setDetail(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function describe(e: LogEvent): string {
  const time = new Date(e.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const kind =
    e.type === "meal"
      ? `🍽️ ${e.dish || "Meal"}`
      : e.type === "symptom"
      ? "🩺 Symptoms"
      : e.type === "bowel"
      ? "🚽 Bowel movement"
      : "🧠 Stress & sleep";
  return `${kind} · ${time}`;
}

function formatDay(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86_400_000).toDateString();
  if (dateStr === today) return "Today";
  if (dateStr === yest) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function TimelineRow({ event, onClick }: { event: LogEvent; onClick: () => void }) {
  const time = new Date(event.createdAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="tl-row" onClick={onClick} role="button">
      <div className="tl-time">{time}</div>
      <div className="tl-dot" data-type={event.type} />
      <div className="tl-body">
        {event.type === "meal" && <MealBody event={event} />}
        {event.type === "symptom" && (
          <>
            <div className="tl-title">🩺 Symptoms</div>
            <div className="sub">{symptomLine(event.symptoms)}</div>
          </>
        )}
        {event.type === "bowel" && (
          <>
            <div className="tl-title">
              🚽 Bowel movement · type {event.bristol}{" "}
              {BRISTOL.find((b) => b.type === event.bristol)?.emoji}
            </div>
            {event.symptoms?.length ? (
              <div className="sub">{symptomLine(event.symptoms)}</div>
            ) : null}
          </>
        )}
        {event.type === "checkin" && (
          <>
            <div className="tl-title">🧠 Stress & sleep</div>
            <div className="sub">
              {[
                event.stress && `Stress: ${event.stress}`,
                event.sleep && `Sleep: ${event.sleep}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </>
        )}
        {event.note && <div className="sub note">📝 {event.note}</div>}
      </div>
    </div>
  );
}

function MealBody({ event }: { event: MealEvent }) {
  const url = useMemo(
    () => (event.photo ? URL.createObjectURL(event.photo) : null),
    [event.photo]
  );
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const confident = event.ingredients
    .filter((i) => i.confidence === "confident")
    .map((i) => i.name)
    .join(", ");

  return (
    <div className="meal-body">
      {url && <img src={url} alt="" className="tl-thumb" />}
      <div>
        <div className="tl-title">🍽️ {event.dish || "Meal"}</div>
        {confident && <div className="sub">{confident}</div>}
      </div>
    </div>
  );
}

function symptomLine(symptoms: { id: string; severity: string }[]): string {
  return symptoms
    .map((s) => `${getSymptom(s.id)?.emoji ?? ""} ${getSymptom(s.id)?.label ?? s.id} (${s.severity})`)
    .join(", ");
}
