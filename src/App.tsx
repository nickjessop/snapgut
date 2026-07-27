import { useState } from "react";
import CameraView from "./CameraView";
import MealReview from "./MealReview";
import SymptomLogView from "./SymptomLogView";
import BowelLogView from "./BowelLogView";
import LogsView from "./LogsView";
import InsightsView from "./InsightsView";

type Tab = "logs" | "insights";
type Flow = null | "camera" | "meal-review" | "symptom" | "bowel";

export default function App() {
  const [tab, setTab] = useState<Tab>("logs");
  const [flow, setFlow] = useState<Flow>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [photo, setPhoto] = useState<Blob | null>(null);

  function closeFlow() {
    setFlow(null);
    setPhoto(null);
  }
  function finishFlow() {
    closeFlow();
    setTab("logs");
  }

  // ---- Full-screen logging flows (over the tab shell) ----
  if (flow === "camera") {
    return (
      <div className="app">
        <CameraView
          onCapture={(p) => {
            setPhoto(p);
            setFlow("meal-review");
          }}
          onClose={closeFlow}
        />
      </div>
    );
  }
  if (flow === "meal-review" && photo) {
    return (
      <div className="app">
        <MealReview photo={photo} onDone={finishFlow} onRetake={() => setFlow("camera")} />
      </div>
    );
  }
  if (flow === "symptom") {
    return (
      <div className="app">
        <SymptomLogView onDone={finishFlow} onCancel={closeFlow} />
      </div>
    );
  }
  if (flow === "bowel") {
    return (
      <div className="app">
        <BowelLogView onDone={finishFlow} onCancel={closeFlow} />
      </div>
    );
  }

  // ---- Tab shell ----
  return (
    <div className="app">
      {tab === "logs" && <LogsView />}
      {tab === "insights" && <InsightsView />}

      {plusOpen && (
        <div className="sheet-backdrop" onClick={() => setPlusOpen(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <button
              className="action-item"
              onClick={() => {
                setPlusOpen(false);
                setFlow("camera");
              }}
            >
              <span className="ai-ico">📷</span>
              <div>
                <div className="ai-title">Food snap</div>
                <div className="ai-sub">Photo → AI ingredients</div>
              </div>
            </button>
            <button
              className="action-item"
              onClick={() => {
                setPlusOpen(false);
                setFlow("symptom");
              }}
            >
              <span className="ai-ico">🩺</span>
              <div>
                <div className="ai-title">Symptom</div>
                <div className="ai-sub">How your gut feels, right now or earlier</div>
              </div>
            </button>
            <button
              className="action-item"
              onClick={() => {
                setPlusOpen(false);
                setFlow("bowel");
              }}
            >
              <span className="ai-ico">🚽</span>
              <div>
                <div className="ai-title">Bowel movement</div>
                <div className="ai-sub">Bristol scale + optional symptoms</div>
              </div>
            </button>
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
