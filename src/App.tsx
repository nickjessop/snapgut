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
import { DEFAULT_APP_PATH, isAppPath } from "../shared/site.js";
import { mayEnterApp, parseRoute, type AddressableFlow } from "./routes";
import useRouter from "./useRouter";

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
  // R4.8 — the App_Shell always opens with zero flows active. No route maps to an
  // Ephemeral_Flow, so the only flow a URL can restore is the addressable one
  // (`settings`), and it is applied by `onRoute` rather than seeded here.
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

  /**
   * The history binding. `enabled` is the boot gate: while the held Session_Token
   * is being validated and while the app is signed out, the URL and the view state
   * do not track each other, so the pre-auth placeholder and the sign-in screen
   * leave the address bar exactly as it was (Requirement 3.6). Flipping it on is
   * what makes a deep link survive the gate.
   */
  const { navigate, redirect } = useRouter({
    tab,
    flow,
    enabled: authChecked && authed,
    onRoute: (route) => {
      setTab(route.tab);
      setFlow(route.flow);
    },
    onCancelFlow: () => cancelFlow(),
  });

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

  /**
   * The boot-order redirects (Requirement 3), in the order of the design's
   * decision ladder:
   *
   *   validating token .......... render the placeholder, URL untouched   (R3.6)
   *   no token, URL is /app/* ... replaceState → /login?next=<path>       (R3.2)
   *   token, URL is /login ...... replaceState → next ?? /app        (R3.1, R3.3)
   *
   * Both redirects replace the current entry rather than adding one, so a boot
   * redirect leaves nothing to go back to. Nothing here runs before the session
   * check settles, so a valid token never flashes the sign-in URL.
   */
  useEffect(() => {
    if (!authChecked) return;
    const { pathname, search } = window.location;

    if (!mayEnterApp(authed)) {
      // R3.2 — the App_Route asked for is carried across as `next`, so sign-in
      // returns to it. `sanitizeNext` (inside `formatRoute`) reduces anything it
      // does not recognise to the default App_Route.
      if (isAppPath(pathname)) redirect({ kind: "login", next: pathname });
      return;
    }

    // R3.1, R3.3 — a session at the Login_Route belongs in the app. `next` is
    // already sanitized by `parseRoute`, and its absence means the default view.
    const here = parseRoute(pathname, search);
    if (here?.kind !== "login") return;
    const target = parseRoute(here.next ?? DEFAULT_APP_PATH);
    if (target?.kind === "app") redirect(target);
  }, [authChecked, authed, redirect]);

  const signOut = () => {
    setAuthed(false);
    setEnt(null);
    // R3.5 — a discarded Session_Token, whether from sign-out or from a 401, lands
    // on the Login_Route. This is a real navigation, not a boot redirect: the entry
    // the user was on stays in history.
    navigate({ kind: "login", next: null });
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

  /**
   * A user-initiated switch between Addressable_Views: the camera, the logs, the
   * insights, and settings. Routed rather than set directly, so the URL and the
   * view state move together and exactly one history entry is added (R4.2). A tap
   * on the view already showing is a no-op, so re-tapping the active tab does not
   * stack a duplicate entry.
   */
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
    // R4.10 — saving a log still lands on the logs view, now expressed as a
    // navigation to the logs App_Route. It replaces rather than pushes because the
    // entry underneath is the sentinel the flow pushed (R4.5): consuming it leaves
    // the flow with no history entry of its own, so a back gesture from the saved
    // log goes where the flow was opened from instead of onto a dead entry.
    redirect({ kind: "app", tab: "logs", flow: null });
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
  /**
   * The flow's existing cancel behavior, unchanged, and the path a backward
   * navigation out of an Ephemeral_Flow runs (R4.6). The view change is left to
   * the state → URL binding rather than routed here: whether the cancel came from
   * a control or from the back gesture, the router corrects the URL by replacing
   * the entry it is already on, so cancelling adds no history entry either way.
   */
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
          onClose={() => goToView("logs")}
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
          onOpenSettings={() => goToView("logs", "settings")}
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
