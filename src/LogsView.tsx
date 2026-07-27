import { useEffect, useMemo, useState } from "react";
import {
  getEvents,
  deleteEvent,
  toCSV,
  type LogEvent,
  type MealEvent,
} from "./db";
import { getSymptom, BRISTOL } from "./symptoms";
import {
  MealIcon,
  SymptomIcon,
  BowelIcon,
  CheckinIcon,
  NoteIcon,
  EditIcon,
  DeleteIcon,
  type IconProps,
} from "./icons";
import type { ComponentType } from "react";

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
        <p className="empty">Nothing logged yet. Tap + or snap a meal to start.</p>
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
            <div className="detail-title">
              <EventLabel event={detail} /> · {formatTime(detail.createdAt)}
            </div>
            <button
              className="action-item"
              onClick={() => {
                const e = detail;
                setDetail(null);
                onEdit(e);
              }}
            >
              <span className="ai-ico">
                <EditIcon size={22} />
              </span>
              <div className="ai-title">Edit</div>
            </button>
            <button className="action-item danger" onClick={() => remove(detail.id)}>
              <span className="ai-ico">
                <DeleteIcon size={22} />
              </span>
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

const KIND: Record<LogEvent["type"], { Icon: ComponentType<IconProps>; label: string }> = {
  meal: { Icon: MealIcon, label: "Meal" },
  symptom: { Icon: SymptomIcon, label: "Symptoms" },
  bowel: { Icon: BowelIcon, label: "Bowel movement" },
  checkin: { Icon: CheckinIcon, label: "Stress & sleep" },
};

/** Inline icon + text label for a log event (used in headers/titles). */
function EventLabel({ event }: { event: LogEvent }) {
  const { Icon, label } = KIND[event.type];
  const text = event.type === "meal" ? event.dish || "Meal" : label;
  return (
    <span className="evt-label">
      <Icon size={16} />
      {text}
    </span>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
            <div className="tl-title">
              <SymptomIcon size={16} /> Symptoms
            </div>
            <div className="sub">{symptomLine(event.symptoms)}</div>
          </>
        )}
        {event.type === "bowel" && (
          <>
            <div className="tl-title">
              <BowelIcon size={16} /> Bowel movement · type {event.bristol}{" "}
              {BRISTOL.find((b) => b.type === event.bristol)?.emoji}
            </div>
            {event.symptoms?.length ? (
              <div className="sub">{symptomLine(event.symptoms)}</div>
            ) : null}
          </>
        )}
        {event.type === "checkin" && (
          <>
            <div className="tl-title">
              <CheckinIcon size={16} /> Stress & sleep
            </div>
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
        {event.note && (
          <div className="sub note">
            <NoteIcon size={13} /> {event.note}
          </div>
        )}
      </div>
    </div>
  );
}

function MealBody({ event }: { event: MealEvent }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!event.photo) return;
    const u = URL.createObjectURL(event.photo);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [event.photo]);

  const confident = event.ingredients
    .filter((i) => i.confidence === "confident")
    .map((i) => i.name)
    .join(", ");

  return (
    <div className="meal-body">
      {url && <img src={url} alt="" className="tl-thumb" />}
      <div>
        <div className="tl-title">
          <MealIcon size={16} /> {event.dish || "Meal"}
        </div>
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
