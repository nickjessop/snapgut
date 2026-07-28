import { useEffect, useMemo, useRef, useState } from "react";
import {
  getEvents,
  deleteEvent,
  toCSV,
  type LogEvent,
  type MealEvent,
} from "./db";
import { getSymptom, BRISTOL } from "./symptoms";
import { MealIcon } from "./icons";
import InstallHint from "./InstallHint";
import {
  exportBackup,
  importBackup,
  isBackupDue,
  getLastBackupAt,
  daysSince,
  snoozeReminder,
} from "./backup";

interface Props {
  onEdit: (event: LogEvent) => void;
  onChanged: () => void; // bump global reload (e.g. after a restore)
  reloadKey: number;
  credits: number | null;
  onOpenPaywall: () => void;
}

export default function LogsView({ onEdit, onChanged, reloadKey, credits, onOpenPaywall }: Props) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [detail, setDetail] = useState<LogEvent | null>(null);
  const [dataSheet, setDataSheet] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [lastBackup, setLastBackup] = useState<number | null>(getLastBackupAt());
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function exportCSV() {
    const csv = toCSV(events, (id) => getSymptom(id)?.label ?? id);
    const blob = new Blob([csv], { type: "text/csv" });
    const file = new File([blob], "snapgut.csv", { type: "text/csv" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: "SnapGut export" });
        setDataSheet(false);
        return;
      } catch {
        /* fall through */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "snapgut.csv";
    a.click();
    URL.revokeObjectURL(url);
    setDataSheet(false);
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
    setDataSheet(false);
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking same file
    if (!file) return;
    setBusy("Restoring…");
    try {
      const n = await importBackup(file);
      const ev = await getEvents();
      setEvents(ev);
      onChanged();
      setToast(`Restored ${n} item${n === 1 ? "" : "s"}`);
    } catch (err) {
      setToast((err as Error).message);
    }
    setBusy(null);
    setDataSheet(false);
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

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
          {streak >= 2 && (
            <span className="streak" title={`${streak}-day logging streak`}>
              🔥 {streak}
            </span>
          )}
          {credits !== null && (
            <button
              className="credits-pill"
              onClick={onOpenPaywall}
              title="Buy AI credits"
            >
              🪙 {credits}
            </button>
          )}
          <button className="icon-round" onClick={() => setDataSheet(true)} aria-label="Data & backup">
            ⚙︎
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
              className="link-btn"
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
        groups.map(([day, dayEvents]) => (
          <div key={day} className="day-group">
            <div className="day-label">{formatDay(day)}</div>
            {dayEvents.map((e) => (
              <TimelineRow key={e.id} event={e} onClick={() => setDetail(e)} />
            ))}
          </div>
        ))
      )}

      {/* hidden import picker */}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={onFilePicked}
      />

      {toast && <div className="toast">{toast}</div>}
      {busy && <div className="toast">{busy}</div>}

      {/* Data & backup sheet */}
      {dataSheet && (
        <div className="sheet-backdrop" onClick={() => setDataSheet(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <div className="detail-title">Data & backup · {statusText}</div>
            <ActionItem icon="⬆️" title="Back up data" sub="Save a full backup (with photos) to Files/iCloud" onClick={doBackup} />
            <ActionItem icon="⬇️" title="Restore from backup" sub="Import a backup file — merges into your log" onClick={() => fileRef.current?.click()} />
            <ActionItem icon="📄" title="Export as CSV" sub="Spreadsheet of your timeline" onClick={exportCSV} />
            <button className="action-cancel" onClick={() => setDataSheet(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

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

function ActionItem({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: string;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className="ai-ico">{icon}</span>
      <div>
        <div className="ai-title">{title}</div>
        <div className="ai-sub">{sub}</div>
      </div>
    </button>
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
            {event.symptoms?.length ? <div className="sub">{symptomLine(event.symptoms)}</div> : null}
          </>
        )}
        {event.type === "checkin" && (
          <>
            <div className="tl-title">🧠 Stress & sleep</div>
            <div className="sub">
              {[event.stress && `Stress: ${event.stress}`, event.sleep && `Sleep: ${event.sleep}`]
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
      <div className="tl-title">🍽️ {event.dish || "Meal"}</div>
      {url && <img src={url} alt="" className="tl-photo" />}
      {confident && <div className="sub">{confident}</div>}
    </div>
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
