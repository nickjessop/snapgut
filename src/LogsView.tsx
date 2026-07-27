import { useEffect, useMemo, useState } from "react";
import { getEvents, toCSV, type LogEvent, type MealEvent } from "./db";
import { getSymptom, BRISTOL } from "./symptoms";

export default function LogsView() {
  const [events, setEvents] = useState<LogEvent[]>([]);

  useEffect(() => {
    getEvents().then(setEvents);
  }, []);

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

  // group by calendar day
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
        <p className="empty">Nothing logged yet. Tap ＋ to start.</p>
      ) : (
        groups.map(([day, dayEvents]) => (
          <div key={day} className="day-group">
            <div className="day-label">{formatDay(day)}</div>
            {dayEvents.map((e) => (
              <TimelineRow key={e.id} event={e} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function formatDay(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86_400_000).toDateString();
  if (dateStr === today) return "Today";
  if (dateStr === yest) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function TimelineRow({ event }: { event: LogEvent }) {
  const time = new Date(event.createdAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="tl-row">
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
