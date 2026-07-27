import { useState } from "react";
import CameraView from "./CameraView";
import MealReview from "./MealReview";
import SymptomLogView from "./SymptomLogView";
import BowelLogView from "./BowelLogView";
import CheckinLogView from "./CheckinLogView";
import LogsView from "./LogsView";
import InsightsView from "./InsightsView";
import type { LogEvent } from "./db";

type Tab = "camera" | "logs" | "insights";
type Flow = null | "meal-review" | "symptom" | "bowel" | "checkin";

export default function App() {
  const [tab, setTab] = useState<Tab>("camera");
  const [flow, setFlow] = useState<Flow>(null);
  const [editing, setEditing] = useState<LogEvent | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  function resetFlow() {
    setFlow(null);
    setEditing(null);
    setPhoto(null);
  }
  function finishFlow() {
    resetFlow();
    setReloadKey((k) => k + 1);
    setTab("logs");
  }
  function cancelFlow() {
    const wasNewMeal = flow === "meal-review" && !editing;
    resetFlow();
    if (wasNewMeal) setTab("camera");
  }

  function startEdit(event: LogEvent) {
    setEditing(event);
    if (event.type === "meal") {
      setPhoto(event.photo ?? null);
      setFlow("meal-review");
    } else if (event.type === "symptom") setFlow("symptom");
    else if (event.type === "bowel") setFlow("bowel");
    else if (event.type === "checkin") setFlow("checkin");
  }

  // ---- Full-screen logging flows ----
  if (flow === "meal-review" && photo) {
    return (
      <div className="app">
        <MealReview
          photo={photo}
          editing={editing?.type === "meal" ? editing : undefined}
          onDone={finishFlow}
          onRetake={cancelFlow}
        />
      </div>
    );
  }
  if (flow === "symptom") {
    return (
      <div className="app">
        <SymptomLogView
          editing={editing?.type === "symptom" ? editing : undefined}
          onDone={finishFlow}
          onCancel={cancelFlow}
        />
      </div>
    );
  }
  if (flow === "bowel") {
    return (
      <div className="app">
        <BowelLogView
          editing={editing?.type === "bowel" ? editing : undefined}
          onDone={finishFlow}
          onCancel={cancelFlow}
        />
      </div>
    );
  }
  if (flow === "checkin") {
    return (
      <div className="app">
        <CheckinLogView
          editing={editing?.type === "checkin" ? editing : undefined}
          onDone={finishFlow}
          onCancel={cancelFlow}
        />
      </div>
    );
  }

  // ---- Tab shell ----
  return (
    <div className="app">
      {tab === "camera" && (
        <CameraView
          onCapture={(p) => {
            setPhoto(p);
            setFlow("meal-review");
          }}
        />
      )}
      {tab === "logs" && <LogsView onEdit={startEdit} reloadKey={reloadKey} />}
      {tab === "insights" && <InsightsView reloadKey={reloadKey} />}

      {plusOpen && (
        <div className="sheet-backdrop" onClick={() => setPlusOpen(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <ActionItem
              icon="📷"
              title="Food snap"
              sub="Photo → AI ingredients"
              onClick={() => {
                setPlusOpen(false);
                setTab("camera");
              }}
            />
            <ActionItem
              icon="🩺"
              title="Symptom"
              sub="How your gut feels, right now or earlier"
              onClick={() => {
                setPlusOpen(false);
                setFlow("symptom");
              }}
            />
            <ActionItem
              icon="🚽"
              title="Bowel movement"
              sub="Bristol scale + optional symptoms"
              onClick={() => {
                setPlusOpen(false);
                setFlow("bowel");
              }}
            />
            <ActionItem
              icon="🧠"
              title="Stress & sleep"
              sub="Gut-brain check-in"
              onClick={() => {
                setPlusOpen(false);
                setFlow("checkin");
              }}
            />
            <button className="action-cancel" onClick={() => setPlusOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <nav className="tabbar">
        <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
          <span className="ico">📖</span>
          Logs
        </button>
        <button className="fab" onClick={() => setPlusOpen(true)} aria-label="Add log">
          ＋
        </button>
        <button
          className={tab === "insights" ? "active" : ""}
          onClick={() => setTab("insights")}
        >
          <span className="ico">✨</span>
          Insights
        </button>
      </nav>
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
