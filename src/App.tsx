import { useEffect, useState } from "react";
import CameraView from "./CameraView";
import CapturePreview from "./CapturePreview";
import MealDetails from "./MealDetails";
import SymptomLogView from "./SymptomLogView";
import BowelLogView from "./BowelLogView";
import CheckinLogView from "./CheckinLogView";
import LogsView from "./LogsView";
import InsightsView from "./InsightsView";
import SettingsView from "./SettingsView";
import Intro, { ONBOARDED_KEY } from "./Intro";
import AuthGate from "./AuthGate";
import Paywall from "./Paywall";
import { getToken, fetchMe, type Entitlement } from "./session";
import { requestPersistentStorage } from "./backup";
import { isSheetsConnected, syncAll } from "./googleSheets";
import { hydrateSyncState, requestSync, startTriggers } from "./cloudSync";
import { applyEntitlement, restore as restoreSyncSettings } from "./syncSettings";
import {
  CameraIcon,
  SymptomIcon,
  BowelIcon,
  CheckinIcon,
  LogsIcon,
  InsightsIcon,
  AddIcon,
  type IconProps,
} from "./icons";
import { sweepTombstones, type LogEvent } from "./db";
import type { ComponentType } from "react";

type Tab = "camera" | "logs" | "insights";
type Flow = null | "capture" | "meal-details" | "symptom" | "bowel" | "checkin" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("camera");
  const [flow, setFlow] = useState<Flow>(null);
  const [editing, setEditing] = useState<LogEvent | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [mealNote, setMealNote] = useState("");
  const [plusOpen, setPlusOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [introDone, setIntroDone] = useState(
    () => localStorage.getItem(ONBOARDED_KEY) === "1"
  );
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [paywall, setPaywall] = useState<null | "out" | "upsell">(null);

  /**
   * The single funnel for every entitlement-carrying server response the UI
   * handles — `/api/me`, `/api/recognize`, `/api/insights`, and checkout — so the
   * rendered gate and the persisted Pro snapshot the Cloud gate reads move
   * together (cloud-sync Req 1.7). The sync endpoints funnel their own responses
   * inside `syncRequest`, so they never come through here.
   */
  function applyEnt(e: Entitlement): void {
    setEnt(e);
    applyEntitlement({ pro: e.pro, proUntil: e.proUntil });
  }

  useEffect(() => {
    requestPersistentStorage();
    // Ambient triggers: `online` (Req 11.4) and the ≥60 s foreground return
    // (Req 11.9), plus the automatic retry timer. Torn down on unmount so no
    // listener and no armed retry outlives this App instance. A trigger that
    // arrives before restoration completes is discarded by the gate, not queued.
    const stopTriggers = startTriggers();

    (async () => {
      if (getToken()) {
        const me = await fetchMe();
        if (me) {
          setAuthed(true);
          applyEnt(me);
        }
      }
      setAuthChecked(true);
      // Mirror local data to Google Sheets on app open when connected (Req 5.2);
      // no-op when disconnected (Req 5.4). Errors surface in Settings, so ignore here.
      if (isSheetsConnected()) {
        void syncAll().catch(() => {});
      }
    })();

    // Cloud startup sequence, in this order on purpose.
    (async () => {
      // The persisted enabled state and Pro snapshot must be read before the
      // first trigger: until `restore()` resolves the state reads fail-closed and
      // a `cold-launch` trigger would be silently discarded (Req 3.9). The
      // Sync_State hydration has no ordering constraint, so it rides along.
      await Promise.all([restoreSyncSettings(), hydrateSyncState()]);
      // Expired tombstones go before the cycle, so a push never carries rows the
      // sweep is about to drop (Req 5.6). An unavailable IndexedDB must not hold
      // back the trigger.
      try {
        await sweepTombstones(Date.now());
      } catch {
        /* best-effort — the sweep runs again on the next launch */
      }
      // Req 11.2 — exactly one Sync_Cycle for the launch. `requestSync` never
      // rejects: a failed cycle is reported through Sync_State.
      void requestSync("cold-launch");
    })();

    return stopTriggers;
  }, []);

  const signOut = () => {
    setAuthed(false);
    setEnt(null);
  };

  // Gate order: validate session → sign in → first-run intro → app.
  if (!authChecked) return <div className="app" />;
  if (!authed) {
    return (
      <AuthGate
        onAuthed={(me) => {
          setAuthed(true);
          applyEnt(me);
        }}
      />
    );
  }
  if (!introDone) {
    return <Intro onFinish={() => setIntroDone(true)} />;
  }

  const paywallEl = paywall && (
    <Paywall
      reason={paywall}
      onClose={() => setPaywall(null)}
      onUpgraded={(e) => {
        applyEnt(e);
        setPaywall(null);
      }}
    />
  );

  function resetFlow() {
    setFlow(null);
    setEditing(null);
    setPhoto(null);
    setMealNote("");
  }
  function finishFlow() {
    resetFlow();
    setReloadKey((k) => k + 1);
    setTab("logs");
    // Mirror the newly saved event to Google Sheets when connected (Req 5.1); the
    // single-flight guard collapses overlapping triggers (Req 5.5). Error status is
    // shown in Settings, so ignore the rejection here.
    if (isSheetsConnected()) {
      void syncAll().catch(() => {});
    }
    // The Cloud destination's own local-write trigger (cloud-sync Req 11.1). The
    // two destinations are independent, so this runs whatever Sheets is doing, and
    // the gate discards it when Cloud is off, not Pro, or signed out.
    void requestSync("local-write");
  }
  function cancelFlow() {
    const wasNewMeal = flow === "capture" || (flow === "meal-details" && !editing);
    resetFlow();
    if (wasNewMeal) setTab("camera");
  }

  function startEdit(event: LogEvent) {
    setEditing(event);
    if (event.type === "meal") {
      setPhoto(event.photo ?? null);
      setMealNote(event.note ?? "");
      setFlow("meal-details");
    } else if (event.type === "symptom") setFlow("symptom");
    else if (event.type === "bowel") setFlow("bowel");
    else if (event.type === "checkin") setFlow("checkin");
  }

  // ---- Meal flow: capture (screen 1) → details (screen 2) ----
  if (flow === "capture" && photo) {
    return (
      <div className="app">
        <CapturePreview
          photo={photo}
          initialNote={mealNote}
          onProceed={(note) => {
            setMealNote(note);
            setFlow("meal-details");
          }}
          onRetake={cancelFlow}
        />
      </div>
    );
  }
  if (flow === "meal-details" && photo) {
    return (
      <div className="app">
        <MealDetails
          photo={photo}
          initialNote={mealNote}
          editing={editing?.type === "meal" ? editing : undefined}
          onSaved={finishFlow}
          onEntitlement={(e) => e && applyEnt(e)}
          onNeedUpgrade={() => setPaywall("out")}
          onSignedOut={signOut}
          onBack={() => {
            // new meal → back to caption screen; editing → cancel out
            if (editing) cancelFlow();
            else setFlow("capture");
          }}
        />
        {paywallEl}
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

  if (flow === "settings") {
    return (
      <div className="app">
        <SettingsView
          entitlement={ent}
          onClose={() => setFlow(null)}
          onUpgrade={() => setPaywall("upsell")}
          onSignedOut={() => {
            resetFlow();
            signOut();
          }}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
        {paywallEl}
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
            setMealNote("");
            setFlow("capture");
          }}
        />
      )}
      {tab === "logs" && (
        <LogsView
          onEdit={startEdit}
          reloadKey={reloadKey}
          entitlement={ent}
          onUpgrade={() => setPaywall("upsell")}
          onOpenSettings={() => setFlow("settings")}
        />
      )}
      {tab === "insights" && (
        <InsightsView
          reloadKey={reloadKey}
          entitlement={ent}
          onEntitlement={(e) => e && applyEnt(e)}
          onNeedUpgrade={() => setPaywall("out")}
          onSignedOut={signOut}
        />
      )}

      {plusOpen && (
        <div className="sheet-backdrop" onClick={() => setPlusOpen(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <ActionItem
              icon={CameraIcon}
              title="Snap a meal"
              sub="Photo → AI ingredients"
              onClick={() => {
                setPlusOpen(false);
                setTab("camera");
              }}
            />
            <ActionItem
              icon={SymptomIcon}
              title="Symptom"
              sub="How your gut feels, right now or earlier"
              onClick={() => {
                setPlusOpen(false);
                setFlow("symptom");
              }}
            />
            <ActionItem
              icon={BowelIcon}
              title="Bowel movement"
              sub="Bristol scale + optional symptoms"
              onClick={() => {
                setPlusOpen(false);
                setFlow("bowel");
              }}
            />
            <ActionItem
              icon={CheckinIcon}
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
          <LogsIcon className="ico" size={22} />
          Logs
        </button>
        <button className="fab" onClick={() => setPlusOpen(true)} aria-label="Add log">
          <AddIcon size={30} strokeWidth={2.25} />
        </button>
        <button
          className={tab === "insights" ? "active" : ""}
          onClick={() => setTab("insights")}
        >
          <InsightsIcon className="ico" size={22} />
          Insights
        </button>
      </nav>

      {paywallEl}
    </div>
  );
}

function ActionItem({
  icon: Icon,
  title,
  sub,
  onClick,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className="ai-ico">
        <Icon size={24} />
      </span>
      <div>
        <div className="ai-title">{title}</div>
        <div className="ai-sub">{sub}</div>
      </div>
    </button>
  );
}
