import { useState } from "react";
import CameraView from "./CameraView";
import ReviewView from "./ReviewView";
import HistoryView from "./HistoryView";
import InsightsView from "./InsightsView";

type Tab = "camera" | "log" | "insights";

export default function App() {
  const [tab, setTab] = useState<Tab>("camera");
  const [reviewPhoto, setReviewPhoto] = useState<Blob | null>(null);

  // The review screen is a modal-ish flow over the camera tab.
  if (reviewPhoto) {
    return (
      <div className="app">
        <ReviewView
          photo={reviewPhoto}
          onDone={() => {
            setReviewPhoto(null);
            setTab("log");
          }}
          onRetake={() => setReviewPhoto(null)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {tab === "camera" && (
        <CameraView
          onCapture={(photo) => setReviewPhoto(photo)}
          onOpenHistory={() => setTab("log")}
        />
      )}
      {tab === "log" && <HistoryView />}
      {tab === "insights" && <InsightsView />}

      <nav className="tabbar">
        <button
          className={tab === "camera" ? "active" : ""}
          onClick={() => setTab("camera")}
        >
          <span className="ico">📷</span>
          Snap
        </button>
        <button
          className={tab === "log" ? "active" : ""}
          onClick={() => setTab("log")}
        >
          <span className="ico">📖</span>
          Log
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
