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
import InstallToast from "./InstallToast";
import { countLogSaved } from "./metrics";
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
   * is being validated, and while the Login_Route's sign-in screen owns the
   * display, the URL and the view state do not track each other, so neither the
   * pre-auth placeholder nor that screen moves the address bar (Requirement 3.6).
   * Flipping it on is what makes a deep link survive the gate.
   *
   * Being signed out is no longer part of this condition — that is the deferred
   * sign-in change. An anonymous visitor routes normally, because every
   * Addressable_View now works without a session. The `"prompt"` sign-in screen
   * likewise leaves routing enabled: it is raised over a view the visitor is
   * already on, and its URL should stay that view's.
   */
  /**
   * Whether a service worker update may reload the page right now.
   *
   * One derived condition rather than a flag per flow. Unsafe whenever an
   * Ephemeral_Flow is open, because each of them holds something a reload cannot
   * restore — `capture` and `meal-details` hold the photo `Blob`, the other three
   * hold unsaved form input (Requirement 4.8) — and while a sign-in screen is up,
   * since reloading mid-verification loses the emailed code's context.
   *
   * `settings` is deliberately safe: it is an Addressable_View, its state is
   * persisted, and a reload returns to it.
   */
  useEffect(() => {
    const busy = isEphemeralFlow(flow) || signIn !== null;
    setSafeToReload(!busy);
  }, [flow, signIn]);

  /**
   * Left-to-right order for the swipe gesture, matching where each view sits in the
   * tab bar: Logs on the left, Insights on the right, the camera in the middle as
   * home. Settings is absent on purpose — it is reached deliberately and swiping into
   * it by accident would be a surprise.
   */
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
    // Uses the idle moment after launch to warm the thumbnails for the foods this
    // device logs most, so the Logs and Foods lists stop popping in one image at a
    // time. Scheduled, not awaited: it must never delay the first paint.
    schedulePreload();
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
   * The boot-order decisions (Requirement 3), in the order of the design's
   * decision ladder:
   *
   *   validating token .......... render the placeholder, URL untouched   (R3.6)
   *   no token, URL is /login ... show the sign-in screen, URL untouched
   *   no token, URL is /app/* ... nothing — the app is open (deferred sign-in)
   *   token, URL is /login ...... replaceState → next ?? /app        (R3.1, R3.3)
   *
   * The third line is what changed. `mayEnterApp` is now unconditional, so the
   * redirect below is unreachable; the call is kept because restoring the gate is
   * then a one-line change in `src/routes.ts` rather than a rewrite here.
   *
   * The redirect replaces the current entry rather than adding one, so a boot
   * redirect leaves nothing to go back to. Nothing here runs before the session
   * check settles, so a valid token never flashes the sign-in URL.
   */
  useEffect(() => {
    if (!authChecked) return;
    const { pathname, search } = window.location;
    const here = parseRoute(pathname, search);

    if (!authed) {
      // The Login_Route is the one path that still means "sign in" — a visitor
      // who navigated here, or who was sent here by sign-out, wants the form.
      if (here?.kind === "login") setSignIn("route");
      // R3.2, retained but unreachable while `mayEnterApp` is unconditional.
      else if (!mayEnterApp(authed) && isAppPath(pathname)) {
        redirect({ kind: "login", next: pathname });
      }
      return;
    }

    setSignIn(null);
    // R3.1, R3.3 — a session at the Login_Route belongs in the app. `next` is
    // already sanitized by `parseRoute`, and its absence means the default view.
    if (here?.kind !== "login") return;
    const target = parseRoute(here.next ?? DEFAULT_APP_PATH);
    if (target?.kind === "app") redirect(target);
  }, [authChecked, authed, redirect]);

  const signOut = () => {
    setAuthed(false);
    setEnt(null);
    // R3.5 — a discarded Session_Token, whether from sign-out or from a 401, lands
    // on the Login_Route. This is a real navigation, not a boot redirect: the entry
    // the user was on stays in history. The boot effect then raises the sign-in
    // screen for it, so signing out still ends on the form.
    navigate({ kind: "login", next: null });
  };

  /**
   * Swipe between the tab-shell views. Routed through `goToView`, so a gesture and a
   * tab tap produce the same URL and the same single history entry (R4.2).
   *
   * Declared here, above the boot-gate early returns below, because it is a hook: on
   * a render that returns early it would otherwise not be called, and the hook order
   * would change between renders.
   *
   * Active only while the tab shell is actually showing. A flow, a sheet, or the
   * sign-in screen owns the horizontal gesture, and swiping the page out from under an
   * unsaved form would discard it. Stops at the ends rather than wrapping, so the
   * gesture cannot loop a user back where they started.
   */
  useSwipeNav({
    enabled: flow === null && signIn === null && paywall === null && !plusOpen,
    onSwipe: (direction) => {
      const from = SWIPE_ORDER.indexOf(tab);
      if (from === -1) return;
      const to = from + (direction === "next" ? 1 : -1);
      if (to < 0 || to >= SWIPE_ORDER.length) return;
      // `goToView` is a hoisted function declaration below; the callback runs long
      // after this render, so referencing it here is safe.
      goToView(SWIPE_ORDER[to]);
    },
  });

  /** Applied by both sign-in screens: the session, the entitlement, and dismissal. */
  const onAuthed = (me: Entitlement) => {
    setAuthed(true);
    applyEnt(me);
    setSignIn(null);
  };

  /**
   * Gate order: validate session → a sign-in screen if one is asked for → the
   * first-run intro → the app.
   *
   * The blanket auth gate is gone. An anonymous visitor falls straight through to
   * the intro and then to the camera, and is asked for an email only when they
   * reach something that needs the server — which is what `"prompt"` is for.
   */
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
    // Aggregate, identifier-free, and the only funnel event the Origin_Server
    // cannot observe for itself: a log is written to IndexedDB and never sent.
    // See `src/metrics.ts` for exactly what leaves the device.
    countLogSaved();
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
  // No `&& photo` here: a meal may be logged without one. The `capture` flow above
  // still requires a photo, because its whole job is previewing one.
  if (flow === "meal-details") {
    return (
      <div className="app">
        <MealDetails
          photo={photo}
          initialNote={mealNote}
          editing={editing?.type === "meal" ? editing : undefined}
          entitlement={ent}
          authed={authed}
          onSaved={finishFlow}
          onEntitlement={(e) => e && applyEnt(e)}
          onNeedUpgrade={() => setPaywall("out")}
          onNeedSignIn={() => setSignIn("prompt")}
          onSignedOut={signOut}
          onAddPhoto={() => goToView("camera")}
          onBack={() => {
            // Editing → cancel out. A new meal → back to the caption screen, unless
            // there is no photo to caption, in which case back means the camera.
            if (editing) cancelFlow();
            else if (photo) setFlow("capture");
            else cancelFlow();
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
          authed={authed}
          onNeedSignIn={() => setSignIn("prompt")}
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
          // Straight to the details screen: there is no photo to preview or
          // caption, so the capture step has nothing to do.
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
          entitlement={ent}
          onUpgrade={() => setPaywall("upsell")}
          onOpenSettings={() => goToView("logs", "settings")}
        />
      )}
      {tab === "insights" && (
        <InsightsView
          reloadKey={reloadKey}
          entitlement={ent}
          authed={authed}
          onEntitlement={(e) => e && applyEnt(e)}
          onNeedUpgrade={() => setPaywall("out")}
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

      {/* Rendered from the tab shell rather than from one tab, so it rides above the
          nav on every screen including the camera — and only here, so it can never
          cover an open flow or the sign-in screen. Stays until dismissed once; after
          that the offer lives in Settings. */}
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
