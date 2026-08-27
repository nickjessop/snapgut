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
import { getToken, fetchMe } from "./session";
import { requestPersistentStorage } from "./backup";
import { hydrateSyncState, requestSync, startTriggers } from "./cloudSync";
import { restore as restoreSyncSettings } from "./syncSettings";
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
import InstallToast from "./InstallToast";
import { schedulePreload } from "./preload";
import type { ComponentType } from "react";
import { DEFAULT_APP_PATH, isAppPath } from "../shared/site.js";
import { mayEnterApp, parseRoute, type AddressableFlow } from "./routes";
import useRouter, { isEphemeralFlow } from "./useRouter";
import { setSafeToReload } from "./swUpdate";
import useSwipeNav from "./useSwipeNav";

// Exported for `src/routes.ts`, which maps URLs onto these two unions rather
// than restating them. Type-only, so the import is erased and no cycle exists
// at runtime.
export type Tab = "camera" | "logs" | "insights";
export type Flow =
  | null
  | "capture"
  | "meal-details"
  | "symptom"
  | "bowel"
  | "checkin"
  | "settings";

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
  /**
   * Which sign-in screen is showing, if any. Deferred sign-in replaced the
   * blanket auth gate with two distinct reasons to ask for an email:
   *
   *   "route"  — the visitor is at the Login_Route. They came to sign in, so this
   *              owns the screen and the URL, exactly as the old gate did.
   *   "prompt" — an AI call site needs a session. The visitor came to log a meal,
   *              so the URL is left alone, the flow's in-memory photo stays in
   *              this component's state, and declining returns them to it.
   */
  const [signIn, setSignIn] = useState<null | "route" | "prompt">(null);

  /**
   * The history binding. `enabled` is the boot gate: while the held Session_Token
   * is being validated, and while the Login_Route's sign-in screen owns the
   * display, the URL and the view state do not track each other.
   */
  useEffect(() => {
    const busy = isEphemeralFlow(flow) || signIn !== null;
    setSafeToReload(!busy);
  }, [flow, signIn]);

  const SWIPE_ORDER: Tab[] = ["logs", "camera", "insights"];

  const { navigate, redirect } = useRouter({
    tab,
    flow,
    enabled: authChecked && signIn !== "route",
    onRoute: (route) => {
      setTab(route.tab);
      setFlow(route.flow);
    },
    onCancelFlow: () => cancelFlow(),
  });

  useEffect(() => {
    requestPersistentStorage();
    schedulePreload();
    const stopTriggers = startTriggers();

    (async () => {
      if (getToken()) {
        const me = await fetchMe();
        if (me) {
          setAuthed(true);
        }
      }
      setAuthChecked(true);
    })();

    (async () => {
      await Promise.all([restoreSyncSettings(), hydrateSyncState()]);
      try {
        await sweepTombstones(Date.now());
      } catch {
        /* best-effort */
      }
      void requestSync("cold-launch");
    })();

    return stopTriggers;
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    const { pathname, search } = window.location;
    const here = parseRoute(pathname, search);

    if (!authed) {
      if (here?.kind === "login") setSignIn("route");
      else if (!mayEnterApp(authed) && isAppPath(pathname)) {
        redirect({ kind: "login", next: pathname });
      }
      return;
    }

    setSignIn(null);
    if (here?.kind !== "login") return;
    const target = parseRoute(here.next ?? DEFAULT_APP_PATH);
    if (target?.kind === "app") redirect(target);
  }, [authChecked, authed, redirect]);

  const signOut = () => {
    setAuthed(false);
    navigate({ kind: "login", next: null });
  };

  useSwipeNav({
    enabled: flow === null && signIn === null && !plusOpen,
    onSwipe: (direction) => {
      const from = SWIPE_ORDER.indexOf(tab);
      if (from === -1) return;
      const to = from + (direction === "next" ? 1 : -1);
      if (to < 0 || to >= SWIPE_ORDER.length) return;
      goToView(SWIPE_ORDER[to]);
    },
  });

  const onAuthed = () => {
    setAuthed(true);
    setSignIn(null);
  };

  if (!authChecked) return <div className="app" />;
  if (signIn !== null) {
    return (
      <AuthGate
        onAuthed={onAuthed}
        {...(signIn === "prompt"
          ? {
              onCancel: () => setSignIn(null),
              heading: "Sign in to use AI",
              sub: "AI recognition and insights run on our server, so they need an account. Logging stays free and stays on your device.",
            }
          : {})}
      />
    );
  }
  if (!introDone) {
    return <Intro onFinish={() => setIntroDone(true)} />;
  }

  function goToView(target: Tab, targetFlow: AddressableFlow | null = null) {
    if (tab === target && flow === targetFlow) return;
    navigate({ kind: "app", tab: target, flow: targetFlow });
  }

  function resetFlow() {
    setFlow(null);
    setEditing(null);
    setPhoto(null);
    setMealNote("");
  }
  function finishFlow() {
    resetFlow();
    setReloadKey((k) => k + 1);
    redirect({ kind: "app", tab: "logs", flow: null });
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
  if (flow === "meal-details") {
    return (
      <div className="app">
        <MealDetails
          photo={photo}
          initialNote={mealNote}
          editing={editing?.type === "meal" ? editing : undefined}
          authed={authed}
          onSaved={finishFlow}
          onNeedSignIn={() => setSignIn("prompt")}
          onSignedOut={signOut}
          onAddPhoto={() => goToView("camera")}
          onBack={() => {
            if (editing) cancelFlow();
            else if (photo) setFlow("capture");
            else cancelFlow();
          }}
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

  if (flow === "settings") {
    return (
      <div className="app">
        <SettingsView
          authed={authed}
          onNeedSignIn={() => setSignIn("prompt")}
          onClose={() => goToView("logs")}
          onSignedOut={() => {
            resetFlow();
            signOut();
          }}
          onChanged={() => setReloadKey((k) => k + 1)}
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
            setMealNote("");
            setFlow("capture");
          }}
          onSkipPhoto={() => {
            setPhoto(null);
            setMealNote("");
            setFlow("meal-details");
          }}
        />
      )}
      {tab === "logs" && (
        <LogsView
          onEdit={startEdit}
          reloadKey={reloadKey}
          onOpenSettings={() => goToView("logs", "settings")}
        />
      )}
      {tab === "insights" && (
        <InsightsView
          reloadKey={reloadKey}
          authed={authed}
          onNeedSignIn={() => setSignIn("prompt")}
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
                goToView("camera");
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

      <InstallToast />

      <nav className="tabbar">
        <button className={tab === "logs" ? "active" : ""} onClick={() => goToView("logs")}>
          <LogsIcon className="ico" size={22} />
          Logs
        </button>
        <button className="fab" onClick={() => setPlusOpen(true)} aria-label="Add log">
          <AddIcon size={30} strokeWidth={2.25} />
        </button>
        <button
          className={tab === "insights" ? "active" : ""}
          onClick={() => goToView("insights")}
        >
          <InsightsIcon className="ico" size={22} />
          Insights
        </button>
      </nav>
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
