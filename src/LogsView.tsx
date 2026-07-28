import { useEffect, useMemo, useState } from "react";
import {
  getEvents,
  deleteEvent,
  type LogEvent,
  type MealEvent,
} from "./db";
import { getSymptom, BRISTOL } from "./symptoms";
import {
  MealIcon,
  SymptomIcon,
  BowelIcon,
  CheckinIcon,
  SettingsIcon,
  EditIcon,
  DeleteIcon,
  NoteIcon,
} from "./icons";
import type { Entitlement } from "./session";
import HeaderStats from "./HeaderStats";
import InstallHint from "./InstallHint";
import {
  exportBackup,
  isBackupDue,
  getLastBackupAt,
  daysSince,
  snoozeReminder,
} from "./backup";

interface Props {
  onEdit: (event: LogEvent) => void;
  reloadKey: number;
  entitlement: Entitlement | null;
  onUpgrade: () => void;
  onOpenSettings: () => void;
}

export default function LogsView({
  onEdit,
  reloadKey,
  entitlement,
  onUpgrade,
  onOpenSettings,
}: Props) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [detail, setDetail] = useState<LogEvent | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [lastBackup, setLastBackup] = useState<number | null>(getLastBackupAt());
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    getEvents().then(setEvents);
  }, [reloadKey]);

  const hasEvents = events.length > 0;
  const due = hasEvents && !nudgeDismissed && isBackupDue(true);

  async function remove(id: string) {
    await deleteEvent(id);
    setEvents((list) => list.filter((e) => e.id !== id));
    setDetail(null);
  }

  async function doBackup() {
    setBusy("Preparing backup…");
    try {
      const n = await exportBackup();
      setLastBackup(getLastBackupAt());
      setNudgeDismissed(true);
      setToast(`Backup ready · ${n} item${n === 1 ? "" : "s"}`);
    } catch {
      setToast("Couldn't create the backup.");
    }
    setBusy(null);
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Group the timeline into month buckets (events already arrive newest-first).
  const groups = useMemo(() => {
    const map = new Map<string, LogEvent[]>();
    for (const e of events) {
      const d = new Date(e.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [events]);

  const streak = useMemo(() => computeStreak(events), [events]);

  const statusText =
    lastBackup === null
      ? "Never backed up"
      : daysSince(lastBackup) === 0
      ? "Backed up today"
      : `Last backup ${daysSince(lastBackup)}d ago`;

  return (
    <div className="history">
      <div className="history-header">
        <h1>Timeline</h1>
        <div className="header-right">
          <HeaderStats entitlement={entitlement} streak={streak} onUpgrade={onUpgrade} />
          <button className="icon-round" onClick={onOpenSettings} aria-label="Settings">
            <SettingsIcon size={20} />
          </button>
        </div>
      </div>

      <InstallHint />

      {due && (
        <div className="nudge">
          <div className="nudge-text">
            Your log lives only on this device. Back it up so you don't lose it.
            <div className="nudge-sub">{statusText}</div>
          </div>
          <div className="nudge-actions">
            <button className="chip selected" onClick={doBackup}>
              Back up
            </button>
            <button
              className="chip"
              onClick={() => {
                snoozeReminder();
                setNudgeDismissed(true);
              }}
            >
              Later
            </button>
          </div>
        </div>
      )}

      {events.length === 0 ? (
        <div className="empty-state">
          <div className="empty-badge">
            <MealIcon size={34} strokeWidth={1.75} />
          </div>
          <h2 className="empty-title">No logs yet</h2>
          <p className="empty-sub">Snap a meal or tap ＋ to start tracking how food makes you feel.</p>
        </div>
      ) : (
        groups.map(([key, monthEvents]) => (
          <div key={key} className="day-group">
            <div className="day-label">{monthLabel(monthEvents[0])}</div>
            {monthEvents.map((e, i) => {
              const prev = monthEvents[i - 1];
              const showDay =
                !prev ||
                new Date(prev.createdAt).toDateString() !==
                  new Date(e.createdAt).toDateString();
              return (
                <TimelineRow
                  key={e.id}
                  event={e}
                  showDay={showDay}
                  onClick={() => setDetail(e)}
                />
              );
            })}
          </div>
        ))
      )}

      {toast && <div className="toast">{toast}</div>}
      {busy && <div className="toast">{busy}</div>}

      {/* event detail sheet */}
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

function monthLabel(e: LogEvent): string {
  return new Date(e.createdAt).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function isToday(ts: number): boolean {
  return new Date(ts).toDateString() === new Date().toDateString();
}

/** Same icon set + styling as the quick-add (+) menu. */
function iconFor(type: LogEvent["type"]) {
  const size = 24;
  if (type === "meal") return <MealIcon size={size} />;
  if (type === "symptom") return <SymptomIcon size={size} />;
  if (type === "bowel") return <BowelIcon size={size} />;
  return <CheckinIcon size={size} />;
}

function TimelineRow({
  event,
  showDay,
  onClick,
}: {
  event: LogEvent;
  showDay: boolean;
  onClick: () => void;
}) {
  const d = new Date(event.createdAt);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div className="tl-row" onClick={onClick} role="button">
      <div className="tl-marker">
        <div className="tl-node">
          {showDay ? (
            <span className={`tl-daynum${isToday(event.createdAt) ? " today" : ""}`}>
              {d.getDate()}
            </span>
          ) : (
            <span className="tl-dot" />
          )}
        </div>
      </div>
      <span className="tl-time">{time}</span>
      <div className="tl-item">
        <span className="tl-ico">{iconFor(event.type)}</span>
        <div className="tl-content">
          {event.type === "meal" && <MealContent event={event} />}
          {event.type === "symptom" && (
            <>
              <div className="tl-title">Symptoms</div>
              <div className="sub">{symptomLine(event.symptoms)}</div>
            </>
          )}
          {event.type === "bowel" && (
            <>
              <div className="tl-title">
                Bowel movement · type {event.bristol}{" "}
                {BRISTOL.find((b) => b.type === event.bristol)?.emoji}
              </div>
              {event.symptoms?.length ? (
                <div className="sub">{symptomLine(event.symptoms)}</div>
              ) : null}
            </>
          )}
          {event.type === "checkin" && (
            <>
              <div className="tl-title">Stress & sleep</div>
              <div className="sub">
                {[event.stress && `Stress: ${event.stress}`, event.sleep && `Sleep: ${event.sleep}`]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </>
          )}
          {event.note && (
            <div className="sub note">
              <NoteIcon size={13} />
              {event.note}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MealContent({ event }: { event: MealEvent }) {
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
    <>
      <div className="tl-title">{event.dish || "Meal"}</div>
      {confident && <div className="sub">{confident}</div>}
      {url && <img src={url} alt="" className="tl-photo" />}
    </>
  );
}

function symptomLine(symptoms: { id: string; severity: string }[]): string {
  return symptoms
    .map((s) => `${getSymptom(s.id)?.emoji ?? ""} ${getSymptom(s.id)?.label ?? s.id} (${s.severity})`)
    .join(", ");
}

/** Consecutive days (ending today or yesterday) with at least one log. */
function computeStreak(events: LogEvent[]): number {
  if (events.length === 0) return 0;
  const days = new Set(events.map((e) => new Date(e.createdAt).toDateString()));
  const cursor = new Date();
  // Don't break the streak just because today isn't logged yet.
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
