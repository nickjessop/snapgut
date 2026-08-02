import { useEffect, useRef, useState } from "react";
import { getEvents, getMeta, toCSV } from "./db";
import { getSymptom } from "./symptoms";
import {
  clearToken,
  fetchMe,
  deleteAccount,
  openPortal,
  type Entitlement,
} from "./session";
import { exportBackup, importBackup, getLastBackupAt, daysSince } from "./backup";
import {
  isSheetsEnabled,
  connect,
  disconnect,
  syncAll,
  reimport,
  getStatus,
  subscribe,
  clearSpreadsheetId,
  withTimeout,
  type SyncStatus,
} from "./googleSheets";
import {
  getSyncState,
  subscribe as subscribeCloud,
  hydrateSyncState,
  requestSync,
  deleteCloudCopy,
  enqueueEntireLocalStore,
  type SyncState,
  type SyncFailure,
} from "./cloudSync";
import {
  applyEntitlement,
  isDestinationEnabled,
  setDestinationEnabled,
  isProEntitled,
  hasAckedDisclosure,
  ackDisclosure,
  getSnapshot as getSyncSettings,
  subscribe as subscribeSyncSettings,
} from "./syncSettings";
import {
  getThemePref,
  setThemePref,
  type ThemePref,
} from "./theme";
import {
  ChevronIcon,
  InsightsIcon,
  BillingIcon,
  BackupIcon,
  RestoreIcon,
  CsvIcon,
  SignOutIcon,
  DeleteIcon,
  LightIcon,
  DarkIcon,
  AutoThemeIcon,
  type IconProps,
} from "./icons";
import type { ComponentType } from "react";
import { APP_BUILD } from "./build";
import BackButton from "./BackButton";
import { clearInsights, listInsights } from "./insightHistory";
import LayoutDiagnostics from "./LayoutDiagnostics";

// Was a hand-typed literal that never changed, and so said nothing about what was
// actually running. Now derived from the build (see src/build.ts).
const DB_NAME = "food-snap"; // internal storage key (kept for back-compat)

/**
 * Req 17.1, 17.7 — the service has 30 seconds to complete an account deletion,
 * so a request still outstanding at that point is treated exactly like an error
 * status: nothing local is touched and the user is offered the retry control.
 */
const ACCOUNT_DELETE_TIMEOUT_MS = 30_000;

/**
 * One plain word per Sync_State, so the state never depends on colour alone
 * (Req 12.10). The dot beside it is decorative and `aria-hidden`.
 */
const CLOUD_STATE_WORDS: Record<SyncState["state"], string> = {
  off: "Off",
  idle: "Waiting",
  syncing: "Syncing",
  synced: "Synced",
  error: "Error",
  blocked_no_pro: "Paused",
};

/** Date plus clock time to the minute, in the device's local zone (Req 12.4). */
function syncTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The message beside the state word (Req 12.1–12.6). Decision D1 is settled as
 * *retain indefinitely*, so `daysUntilPurge` is `null` in practice and the
 * paused message says the cloud copy is kept. The countdown branch of Req 13.10
 * is still written, because `SyncState` carries the deadline and the message has
 * to stay total over it: if D1 is ever reversed, the shell starts reporting a
 * number and this line states the remaining whole days without further change.
 */
function cloudStatusMessage(s: SyncState): string {
  switch (s.state) {
    // Req 12.1 — off covers both "not enabled" and "signed out".
    case "off":
      return "Cloud sync is off. Your logs stay on this device.";
    // Req 12.2 — either "nothing has synced yet" or "changes are waiting" plus
    // the last successful sync.
    case "idle":
      if (s.lastSyncAt === null) return "No sync has completed yet.";
      return s.pending > 0
        ? `${plural(s.pending, "change", "changes")} waiting to sync · last synced ${syncTime(s.lastSyncAt)}`
        : `Waiting to sync · last synced ${syncTime(s.lastSyncAt)}`;
    // Req 12.3
    case "syncing":
      return "Syncing your timeline with SnapGut Cloud…";
    // Req 12.4, plus the skipped count of Req 20.5.
    case "synced":
      return s.skipped > 0
        ? `Last synced ${syncTime(s.lastSyncAt)} · ${plural(s.skipped, "record", "records")} skipped as unreadable`
        : `Last synced ${syncTime(s.lastSyncAt)}`;
    // Req 12.5 — the message already distinguishes offline from service and says
    // local data is unchanged; the timestamp is appended where one exists.
    case "error":
      return s.lastSyncAt === null
        ? s.message
        : `${s.message} Last synced ${syncTime(s.lastSyncAt)}.`;
    // Req 12.6, 13.5, 13.10.
    case "blocked_no_pro":
      return (
        "Cloud sync is paused because Pro isn't active. Every log on this device is intact, " +
        "backups and CSV export still work, and " +
        (s.daysUntilPurge === null
          ? "your cloud copy is kept for whenever you come back. "
          : `your cloud copy is deleted ${plural(s.daysUntilPurge, "day", "days")} from now unless Pro is restored. `) +
        "Restore Pro below to resume syncing." +
        (s.lastSyncAt === null ? "" : ` Last synced ${syncTime(s.lastSyncAt)}.`)
      );
  }
}

/**
 * The Google Sheets block reports its own state, in its own words, on its own
 * status line (Req 3.3, D6 — the two destinations never share one line and
 * neither one's state is derived from the other's).
 *
 * `paused` is the Req 15.8 state: Pro is not active while the Sheets destination
 * is still enabled. It is deliberately a *separate* key from `disconnected`, so
 * a lapse never reads as "you never set this up" — the message says the logs and
 * the spreadsheet are both kept and how to get syncing back.
 */
type SheetsStateKey =
  | "paused"
  | "disconnected"
  | "connected"
  | "syncing"
  | "synced"
  | "error";

/** One plain word per Sheets state, so state never rests on colour alone. */
const SHEETS_STATE_WORDS: Record<SheetsStateKey, string> = {
  paused: "Paused",
  disconnected: "Not connected",
  connected: "Connected",
  syncing: "Syncing",
  synced: "Synced",
  error: "Error",
};

/**
 * Paused outranks every underlying status (Req 15.8), mirroring the way
 * `blocked_no_pro` outranks `error` and `syncing` on the Cloud line: a lapse
 * during a failed or in-flight Sheets sync reads as paused, not broken.
 */
function sheetsStateKey(status: SyncStatus, paused: boolean): SheetsStateKey {
  if (paused) return "paused";
  switch (status.state) {
    case "disabled":
    case "disconnected":
      return "disconnected";
    case "connected":
      return status.lastSyncAt === null ? "connected" : "synced";
    case "syncing":
      return "syncing";
    case "synced":
      return "synced";
    case "error":
      return "error";
  }
}

/** The message beside the Sheets state word. */
function sheetsStatusMessage(status: SyncStatus, key: SheetsStateKey): string {
  const at = status.state === "disabled" || status.state === "disconnected" ? null : status.lastSyncAt;
  const last = at === null ? "" : ` Last synced ${syncTime(at)}.`;
  switch (key) {
    // Req 15.8 — distinguishable from not-connected: the data and the
    // spreadsheet are retained, and the way back to Pro is named.
    case "paused":
      return (
        "Sheets sync is paused because Pro isn't active. Every log on this device is intact and " +
        "your spreadsheet stays in Google Drive exactly as it is — nothing is deleted or changed. " +
        "Restore Pro below to resume syncing to that same spreadsheet." +
        last
      );
    case "disconnected":
      return "No spreadsheet connected. Your logs stay on this device.";
    case "connected":
      return "Connected · nothing has been written to the spreadsheet yet.";
    case "syncing":
      return "Writing your timeline to the spreadsheet…";
    case "synced":
      return `Your timeline is mirrored to the spreadsheet.${last}`;
    case "error":
      return `${status.state === "error" ? status.message : "Sync failed"}. Your logs on this device are unchanged.${last}`;
  }
}

/** Why a cloud-copy deletion failed, in the user's terms (Req 17.7-style retry). */
function describeDeleteFailure(failure: SyncFailure | null): string {
  const detail =
    failure === null
      ? ""
      : failure.kind === "offline"
      ? " This device is offline."
      : failure.kind === "unauthorized"
      ? " You're signed out."
      : failure.kind === "rate_limited"
      ? " Too many requests just now — try again in a minute."
      : "";
  return `The cloud copy wasn't deleted.${detail} Nothing on this device changed.`;
}

interface Props {
  entitlement: Entitlement | null;
  /** Whether a session is held. Without one there is no account to manage,
   *  no subscription to buy, and nothing server-side to delete. */
  authed?: boolean;
  onNeedSignIn?: () => void;
  onClose: () => void;
  onUpgrade: () => void;
  onSignedOut: () => void;
  onChanged: () => void; // bump global reload after a restore
}

export default function SettingsView({
  entitlement,
  authed = true,
  onNeedSignIn,
  onClose,
  onUpgrade,
  onSignedOut,
  onChanged,
}: Props) {
  const [email, setEmail] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastBackup, setLastBackup] = useState<number | null>(getLastBackupAt());
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const [sheetStatus, setSheetStatus] = useState<SyncStatus>(() => getStatus());
  // SnapGut Cloud block (Req 1.1, 1.2, 3.3, 12.1–12.7).
  const [cloudState, setCloudState] = useState<SyncState>(() => getSyncState());
  const [cloudEnabled, setCloudEnabled] = useState(() => isDestinationEnabled("cloud"));
  /** Whether any past insight is stored, so the clear control appears only when it
   *  would do something. */
  const [insightsStored, setInsightsStored] = useState(false);
  /** Layout numbers, revealed by tapping the build id. See the note at its render. */
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  /**
   * The shared entitlement snapshot both destination blocks gate on (Req 1.2,
   * 15.1). It comes from `syncSettings`, not from the `entitlement` prop, so a
   * lapse observed by any API response reaches both blocks the moment it lands.
   */
  const [proEntitled, setProEntitled] = useState(() => isProEntitled());
  /** Req 15.8 — the paused line needs the Sheets *enabled* state, not its status. */
  const [sheetsDestEnabled, setSheetsDestEnabled] = useState(() =>
    isDestinationEnabled("sheets"),
  );
  /** Req 3.10 — the last enabled-state write was not durable. */
  const [cloudUnsaved, setCloudUnsaved] = useState(false);
  /** Req 10.8 — kept on screen until the user dismisses it. */
  const [restoreSummary, setRestoreSummary] = useState<
    { merged: number; skipped: number } | null
  >(null);
  /** Req 18.6, 18.9 — `enable` also switches the destination on once acked. */
  const [disclosure, setDisclosure] = useState<"notice" | "enable" | null>(null);
  const [confirmCloudDelete, setConfirmCloudDelete] = useState(false);
  /** Req 17.7-style retry affordance for a cloud-copy deletion that failed. */
  const [cloudDeleteError, setCloudDeleteError] = useState<string | null>(null);
  /** Req 17.7 — the account was not deleted; the retry control sits beside this. */
  const [accountDeleteError, setAccountDeleteError] = useState<string | null>(null);
  const prevCloudState = useRef<SyncState>(cloudState);
  const fileRef = useRef<HTMLInputElement>(null);

  function chooseTheme(pref: ThemePref) {
    setTheme(pref);
    setThemePref(pref);
  }

  // Independent of the session. Insights are generated while signed in but stay on
  // the device afterwards, so someone who has signed out must still be able to
  // remove them — putting this behind the `fetchMe` guard would strand them.
  useEffect(() => {
    void listInsights().then((list) => setInsightsStored(list.length > 0));
  }, []);

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me) return;
      setEmail(me.email);
      // Req 1.7 — the `/api/me` response carries a Pro_Entitlement snapshot, so
      // it goes through the shared settings module rather than being read for the
      // email alone. `applyEntitlement` persists the snapshot (Req 1.8) and
      // notifies synchronously, so the Cloud toggle, the Sheets block, and the
      // backup-suppression predicate all see this answer in the same tick — well
      // inside the 1-second bound, and without waiting for a sync response.
      applyEntitlement({ pro: me.pro, proUntil: me.proUntil });
      // Req 18.6 — an unacknowledged disclosure is shown on open, with no
      // further user action, for the signed-in identity.
      if (!hasAckedDisclosure(me.email)) setDisclosure((d) => d ?? "notice");
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the Google Sheets block in step with the module's status (Req 6.1–6.4).
  useEffect(() => {
    setSheetStatus(getStatus());
    return subscribe(setSheetStatus);
  }, []);

  // Keep the Cloud block in step with the derived Sync_State (Req 12.1–12.7).
  // `hydrateSyncState()` reads the persisted last-sync timestamp and Outbox count
  // so the first paint after a restart shows the same values as before it
  // (Req 12.4).
  useEffect(() => {
    setCloudState(getSyncState());
    hydrateSyncState().then(() => setCloudState(getSyncState()));
    return subscribeCloud((next) => {
      const prev = prevCloudState.current;
      prevCloudState.current = next;
      // Req 10.8 — an initial pull that just ended reports its totals and stays
      // on screen until dismissed. The in-progress indication of Req 10.2 is
      // derived from `syncing.restore`, so it disappears with the state itself.
      if (prev.state === "syncing" && prev.restore !== null && next.state !== "syncing") {
        setRestoreSummary({
          merged: prev.restore.merged,
          skipped: next.state === "synced" ? next.skipped : 0,
        });
      }
      setCloudState(next);
    });
  }, []);

  // The toggle position and the Pro gate come from Sync_Settings and nowhere
  // else (Req 1.1, 1.2, 3.3, 3.8), including the unsaved indication of Req 3.10.
  useEffect(() => {
    function read() {
      const s = getSyncSettings();
      setCloudEnabled(s.enabled.cloud);
      // Req 3.3, D6 — the two enabled states are read independently; neither
      // block's rendering consults the other's flag.
      setSheetsDestEnabled(s.enabled.sheets);
      setProEntitled(isProEntitled());
      setCloudUnsaved(s.persistFailed === "cloud");
    }
    read();
    return subscribeSyncSettings(read);
  }, []);

  const pro = entitlement?.pro ?? false;
  const planLabel = pro
    ? entitlement?.proUntil == null
      ? "SnapGut Pro · Lifetime"
      : `SnapGut Pro · renews ${new Date(entitlement.proUntil).toLocaleDateString()}`
    : "Free plan";
  const freeLeft = entitlement
    ? Math.max(0, entitlement.freeAiLimit - entitlement.freeAiUsed)
    : 0;
  const backupStatus =
    lastBackup === null
      ? "Never backed up"
      : daysSince(lastBackup) === 0
      ? "Backed up today"
      : `Last backup ${daysSince(lastBackup)}d ago`;

  // Sheets block visibility (Req 1.2 of the Sheets spec — no Client ID, no block)
  // and its own status line (Req 3.3, 6.1–6.4, 15.8).
  const sheetsEnabled = isSheetsEnabled();
  const sheetsConnected =
    sheetStatus.state !== "disabled" && sheetStatus.state !== "disconnected";
  // Req 15.8 — Pro is off while the destination is still switched on.
  const sheetsPaused = !proEntitled && sheetsDestEnabled;
  const sheetsKey = sheetsStateKey(sheetStatus, sheetsPaused);
  const sheetsWord = SHEETS_STATE_WORDS[sheetsKey];
  const sheetsMessage = sheetsStatusMessage(sheetStatus, sheetsKey);
  // Req 15.1 — every Sheets control is non-interactive while Pro is off; Req 15.3
  // — they are interactive once Pro is back, which covers the active case.
  const sheetsLocked = !proEntitled;

  // Req 12.10 — the state word carries the meaning; the dot only reinforces it.
  const cloudWord = CLOUD_STATE_WORDS[cloudState.state];
  const cloudMessage = cloudStatusMessage(cloudState);

  /**
   * Req 1.10 — activating the toggle without Pro leaves the persisted enabled
   * state and the reported Sync_State untouched and opens the upgrade flow.
   * Req 18.9 — the first enable waits for the disclosure to be acknowledged.
   */
  async function toggleCloud() {
    if (!proEntitled) {
      onUpgrade();
      return;
    }
    if (cloudEnabled) {
      const { persisted } = setDestinationEnabled("cloud", false);
      setCloudUnsaved(!persisted);
      setToast("Cloud sync turned off");
      return;
    }
    if (!hasAckedDisclosure(email)) {
      setDisclosure("enable");
      return;
    }
    await enableCloud();
  }

  async function enableCloud() {
    const { persisted } = setDestinationEnabled("cloud", true);
    setCloudUnsaved(!persisted);
    setBusy("Starting Cloud sync…");
    try {
      // Req 10.9 — a first enable on a device that already holds a timeline
      // queues every Log_Event and Tombstone before the first push phase runs.
      const cursor = await getMeta<string>("cursor");
      if (!cursor) await enqueueEntireLocalStore();
    } catch {
      /* the next Sync_Cycle re-derives what is still pending */
    }
    setBusy(null);
    void requestSync("manual");
  }

  /** Req 18.9 — persist the acknowledgement, then finish the enable it gated. */
  async function acknowledgeDisclosure() {
    const mode = disclosure;
    if (email) ackDisclosure(email);
    setDisclosure(null);
    if (mode === "enable" && proEntitled) await enableCloud();
  }

  /** Req 11.3 — one Sync_Cycle per activation. */
  function syncCloudNow() {
    setToast("Syncing to SnapGut Cloud…");
    void requestSync("manual");
  }

  /** Req 17.4, 17.5 — runs only after the Req 17.8 confirmation. */
  async function reallyDeleteCloudCopy() {
    setConfirmCloudDelete(false);
    setCloudDeleteError(null);
    setBusy("Deleting cloud copy…");
    const res = await deleteCloudCopy();
    setBusy(null);
    if (!res.ok) {
      setCloudDeleteError(describeDeleteFailure(res.failure));
      setToast("Couldn't delete the cloud copy.");
      return;
    }
    setToast(`Cloud copy deleted · ${res.deleted} record${res.deleted === 1 ? "" : "s"}`);
    if (!res.localCleared) {
      setCloudDeleteError(
        "The cloud copy is gone and Cloud sync is off, but this device couldn't finish clearing its sync bookkeeping.",
      );
    }
  }

  async function doBackup() {
    setBusy("Preparing backup…");
    try {
      const n = await exportBackup();
      setLastBackup(getLastBackupAt());
      setToast(`Backup ready · ${n} item${n === 1 ? "" : "s"}`);
    } catch {
      setToast("Couldn't create the backup.");
    }
    setBusy(null);
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("Restoring…");
    try {
      const { imported, skipped } = await importBackup(file);
      onChanged();
      // A partial restore is reported as partial. Saying "Restored 40 items" while
      // quietly dropping three is the kind of reassurance that costs trust later.
      setToast(
        skipped > 0
          ? `Restored ${imported} item${imported === 1 ? "" : "s"} · ${skipped} couldn't be read`
          : `Restored ${imported} item${imported === 1 ? "" : "s"}`
      );
    } catch (err) {
      setToast((err as Error).message);
    }
    setBusy(null);
  }

  async function doConnect() {
    setBusy("Connecting to Google…");
    try {
      await connect();
      setToast("Google Sheets connected");
    } catch (err) {
      // Cancel/denial (2.5), create/header failure (2.7), consent timeout (2.8).
      setToast((err as Error).message || "Couldn't connect to Google Sheets.");
    }
    setBusy(null);
  }

  async function doSync() {
    setBusy("Syncing…");
    try {
      await syncAll();
      setToast("Synced to Google Sheets");
    } catch (err) {
      setToast((err as Error).message || "Sync didn't complete.");
    }
    setBusy(null);
  }

  async function doReimport() {
    setBusy("Re-importing…");
    try {
      const { imported, skipped } = await reimport();
      onChanged();
      setToast(`Imported ${imported} · skipped ${skipped}`);
    } catch (err) {
      setToast((err as Error).message || "Couldn't read the spreadsheet.");
    }
    setBusy(null);
  }

  async function doDisconnect() {
    setBusy("Disconnecting…");
    try {
      await disconnect();
      setToast("Google Sheets disconnected");
    } catch (err) {
      setToast((err as Error).message || "Disconnected.");
    }
    setBusy(null);
  }

  async function exportCSV() {
    const events = await getEvents();
    const csv = toCSV(events, (id) => getSymptom(id)?.label ?? id);
    const blob = new Blob([csv], { type: "text/csv" });
    const file = new File([blob], "snapgut.csv", { type: "text/csv" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: "SnapGut export" });
        return;
      } catch {
        /* fall through to download */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "snapgut.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function manageSubscription() {
    setBusy("Opening billing…");
    try {
      const { url } = await openPortal();
      if (url) window.location.href = url;
      else setToast("Billing portal isn't available.");
    } catch {
      setToast("Couldn't open the billing portal.");
    }
    setBusy(null);
  }

  function signOut() {
    clearToken();
    onSignedOut();
  }

  /**
   * Req 17.3, 17.7, 17.9 — the local wipe runs **only** after a success status.
   *
   * The server deletes every stored Event_Record and Tombstone before removing
   * the user record and answers success only once both are done (Req 17.1), so a
   * success here is the single signal that clearing this device is safe. Until it
   * arrives — and on an error status or a request still outstanding after 30
   * seconds — nothing local is touched: the Local_Store, the Outbox, the
   * Sync_Cursor, every persisted Sync_Settings value, both destinations' enabled
   * states, and the Session_Token all stay exactly as they were, no retry is
   * issued automatically, and the retry control below is the only way the request
   * repeats (Req 17.7). Repeating it is safe because deletion is idempotent
   * server-side (Req 17.2).
   */
  async function reallyDelete() {
    setConfirmDelete(false);
    setAccountDeleteError(null);
    setBusy("Deleting account…");
    try {
      await withTimeout(
        deleteAccount(),
        ACCOUNT_DELETE_TIMEOUT_MS,
        "account_delete_timeout",
      );
    } catch {
      // Req 17.7 — the failure path performs no clearing of any kind.
      setBusy(null);
      setAccountDeleteError(
        "Your account wasn't deleted. Nothing on this device changed — every log, photo, " +
          "and sync setting is still here and you're still signed in. You can try again below.",
      );
      setToast("Couldn't delete the account.");
      return;
    }

    // Success (Req 17.3) — the Local_Store, the Outbox, and the Sync_Cursor all
    // live in this one database, so dropping it clears all three.
    try {
      indexedDB.deleteDatabase(DB_NAME);
    } catch {
      /* ignore */
    }
    // Req 17.9 — the Sheets destination is switched off and the stored
    // spreadsheet identifier is dropped. Neither call writes to Google, so the
    // spreadsheet in the user's own Drive is left exactly as it is.
    try {
      setDestinationEnabled("sheets", false);
      clearSpreadsheetId();
    } catch {
      /* best-effort — the prefix sweep below removes both keys regardless */
    }
    // Req 17.3 — the existing `food-snap` / `snapgut` sweep, which already covers
    // the `snapgut-sync-*` Sync_Settings keys and the Sheets keys.
    Object.keys(localStorage)
      .filter((k) => k.startsWith("food-snap") || k.startsWith("snapgut"))
      .forEach((k) => localStorage.removeItem(k));
    clearToken();
    setBusy(null);
    onSignedOut();
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <BackButton onClick={onClose} label="Back to your log" />
        <h1>Settings</h1>
        <div style={{ width: 40 }} />
      </div>

      <div className="settings-scroll">
        {/* Account */}
        <section className="settings-section">
          <div className="settings-label">Account</div>
          <div className="settings-card">
            <Row label="Email" value={authed ? email || "—" : "Not signed in"} />
            <div className="settings-divider" />
            <Row label="Plan" value={authed ? planLabel : "No account"} />
            {authed && !pro && (
              <>
                <div className="settings-divider" />
                <Row label="Free AI left" value={`${freeLeft} of ${entitlement?.freeAiLimit ?? 0}`} />
              </>
            )}
          </div>
          {/* Nothing to sell or manage without an account. Offer the free step
              first: sign-in is what unlocks the AI trial, and Pro is what unlocks
              it without limit. Reversing that order would ask for money to solve
              a problem an email address solves. */}
          {!authed ? (
            <SettingsItem
              icon={InsightsIcon}
              title="Sign in"
              sub="Keeps your logs on this device — unlocks AI recognition & insights"
              chevron
              accent
              onClick={() => onNeedSignIn?.()}
            />
          ) : pro ? (
            <SettingsItem
              icon={BillingIcon}
              title="Manage subscription"
              sub="Update payment or cancel in the billing portal"
              chevron
              onClick={manageSubscription}
            />
          ) : (
            <SettingsItem
              icon={InsightsIcon}
              title="Upgrade to SnapGut Pro"
              sub="Unlimited AI recognition & insights"
              chevron
              accent
              onClick={onUpgrade}
            />
          )}
        </section>

        {/* Appearance */}
        <section className="settings-section">
          <div className="settings-label">Appearance</div>
          <div className="seg theme-seg">
            <ThemeOption
              icon={AutoThemeIcon}
              label="Auto"
              on={theme === "auto"}
              onClick={() => chooseTheme("auto")}
            />
            <ThemeOption
              icon={LightIcon}
              label="Light"
              on={theme === "light"}
              onClick={() => chooseTheme("light")}
            />
            <ThemeOption
              icon={DarkIcon}
              label="Dark"
              on={theme === "dark"}
              onClick={() => chooseTheme("dark")}
            />
          </div>
          <div className="settings-hint">
            Auto follows your device's light or dark setting.
          </div>
        </section>

        {/* Data */}
        <section className="settings-section">
          <div className="settings-label">Your data · {backupStatus}</div>
          <SettingsItem
            icon={BackupIcon}
            title="Back up data"
            sub="Save a full backup (with photos) to Files/iCloud"
            chevron
            onClick={doBackup}
          />
          <SettingsItem
            icon={RestoreIcon}
            title="Restore from backup"
            sub="Import a backup file — merges into your log"
            chevron
            onClick={() => fileRef.current?.click()}
          />
          {/* Said plainly, next to the control that prevents it.
 
              Removing an installed web app deletes its storage with it, on iOS and
              Android both, and there is no uninstall event to warn on — by the time
              the OS acts, no code of ours runs again. So the only honest place for
              this is before it happens, beside the backup controls, rather than a
              confirmation that can never fire. */}
          <div className="settings-hint">
            Deleting SnapGut from your Home Screen deletes this log with it, and
            clearing your browser's site data does the same. A backup file, or Cloud
            sync, is what survives that.
          </div>
          <SettingsItem
            icon={CsvIcon}
            title="Export as CSV"
            sub="Spreadsheet of your timeline"
            chevron
            onClick={exportCSV}
          />
          {/* Insights are now kept rather than discarded on navigation, so there has
              to be a way to remove them. They are AI-written text about someone's
              health log: new stored data needs a delete control in the same place as
              every other one, not only an account-wide wipe. */}
          {insightsStored && (
            <SettingsItem
              icon={DeleteIcon}
              title="Clear past insights"
              sub="Removes saved AI insights from this device — your log is untouched"
              onClick={async () => {
                await clearInsights();
                setInsightsStored(false);
                setToast("Past insights cleared");
                onChanged();
              }}
            />
          )}

          {/* SnapGut Cloud — an independent destination, always shown so a free
              user can see what Pro unlocks (Req 1.2, 3.3) */}
          <div className="settings-label">SnapGut Cloud</div>
          <ToggleRow
            title="Sync with SnapGut Cloud"
            sub={
              proEntitled
                ? "Keep your timeline on every device you sign in to"
                : "Pro feature — your logs stay on this device until you upgrade"
            }
            on={cloudEnabled}
            locked={!proEntitled}
            onToggle={toggleCloud}
          />

          {/* Req 12.10 — a live region, so each state change reaches assistive
              technology without moving focus or reloading the view */}
          <div className="settings-card cloud-status" role="status" aria-live="polite">
            <div className="cloud-state-line">
              <span className={`cloud-dot ${cloudState.state}`} aria-hidden="true" />
              <span className="cloud-state-word">{cloudWord}</span>
            </div>
            <p className="cloud-state-msg">{cloudMessage}</p>
            {/* Req 10.2 — merged-so-far count while an initial pull runs */}
            {cloudState.state === "syncing" && cloudState.restore !== null && (
              <p className="cloud-state-msg">
                Restoring your timeline · {plural(cloudState.restore.merged, "event", "events")}{" "}
                merged so far
              </p>
            )}
          </div>

          {/* Req 3.10 — the change is live this session but may not survive a restart */}
          {cloudUnsaved && (
            <div className="settings-hint">
              This device couldn't save the Cloud sync setting, so it may not stick after a
              restart.
            </div>
          )}

          {/* Req 10.8 — stays until dismissed */}
          {restoreSummary && (
            <div className="settings-card cloud-status">
              <p className="cloud-state-msg">
                Restore complete · {plural(restoreSummary.merged, "event", "events")} merged
                {restoreSummary.skipped > 0
                  ? `, ${plural(restoreSummary.skipped, "record", "records")} skipped as unreadable`
                  : ""}
                .
              </p>
              <button className="cloud-dismiss" onClick={() => setRestoreSummary(null)}>
                Dismiss
              </button>
            </div>
          )}

          {/* Req 1.2, 13.5 — the control that resumes a lapsed Cloud sync.
              With no account there is nothing to upgrade: Cloud sync is keyed to an
              email, so sign-in is the step that has to come first.

              A plain "Upgrade to SnapGut Pro" used to sit here too, which meant a
              signed-in free user saw the identical row twice on one screen — once
              under Account and again here. The Account row is the canonical one, so
              this now appears only in the case that row cannot express: Pro has
              lapsed while Cloud sync is still switched on, and the cloud copy is
              waiting to be resumed rather than bought for the first time. */}
          {!authed ? (
            <SettingsItem
              icon={InsightsIcon}
              title="Sign in to use Cloud sync"
              sub="Cloud sync needs an account — your logs stay on this device until you turn it on"
              chevron
              accent
              onClick={() => onNeedSignIn?.()}
            />
          ) : (
            !proEntitled && (
              <SettingsItem
                icon={InsightsIcon}
                // Retitled rather than removed. The duplication complaint was real —
                // this row and the one under Account both read "Upgrade to SnapGut
                // Pro", so the same CTA appeared twice on one screen — but the row
                // itself is required: the Cloud toggle above is locked, and
                // cloud-sync Requirement 1.2 wants an interactive way to unlock it
                // next to the thing being unlocked. Naming what *this* one buys
                // removes the repetition without removing the affordance.
                title={cloudEnabled ? "Restore SnapGut Pro" : "Unlock Cloud sync"}
                sub={
                  cloudEnabled
                    ? "Resume Cloud sync — your cloud copy is still there"
                    : "Unlocks Cloud sync across your devices"
                }
                chevron
                accent
                onClick={onUpgrade}
              />
            )
          )}

          {proEntitled && cloudEnabled && (
            <SettingsItem
              icon={BackupIcon}
              title="Sync now"
              sub="Push and pull changes right away"
              chevron
              onClick={syncCloudNow}
            />
          )}

          <SettingsItem
            icon={CsvIcon}
            title="What Cloud sync uploads"
            sub="Read the data disclosure again"
            chevron
            onClick={() => setDisclosure("notice")}
          />

          <SettingsItem
            icon={DeleteIcon}
            title="Delete cloud copy"
            sub="Erase what SnapGut Cloud holds — this device keeps its logs"
            danger
            onClick={() => setConfirmCloudDelete(true)}
          />

          {cloudDeleteError && (
            <>
              <div className="settings-hint">{cloudDeleteError}</div>
              <SettingsItem
                icon={DeleteIcon}
                title="Try deleting the cloud copy again"
                sub="Repeat the request"
                danger
                onClick={() => setConfirmCloudDelete(true)}
              />
            </>
          )}

          {/* Google Sheets — a second, fully independent destination (Req 3.3,
              D6). Hidden entirely without a Client ID (Sheets spec Req 1.2), and
              Pro-gated on its own account (Req 15.1, 15.3). */}
          {sheetsEnabled && (
            <>
              <div className="settings-label">Google Sheets</div>

              {/* Req 3.3, 15.8 — this destination's own status line, in its own
                  live region, so a change to one destination never rewrites the
                  other's line (Req 15.7) */}
              <div
                className="settings-card sheets-status"
                role="status"
                aria-live="polite"
              >
                <div className="cloud-state-line">
                  <span className={`cloud-dot ${sheetsKey}`} aria-hidden="true" />
                  <span className="cloud-state-word">{sheetsWord}</span>
                </div>
                <p className="cloud-state-msg">{sheetsMessage}</p>
              </div>

              {/* Req 15.1 — the separate interactive control that opens the
                  upgrade flow while every Sheets control above is locked */}
              {sheetsLocked && (
                <SettingsItem
                  icon={InsightsIcon}
                  title={
                    sheetsDestEnabled
                      ? "Restore Pro to resume Sheets sync"
                      : "Upgrade to Pro for Sheets sync"
                  }
                  sub={
                    sheetsDestEnabled
                      ? "Your logs and your spreadsheet are waiting exactly as they are"
                      : "Pro mirrors your log to a spreadsheet in your Drive"
                  }
                  chevron
                  accent
                  onClick={onUpgrade}
                />
              )}

              {!sheetsConnected ? (
                <SettingsItem
                  icon={CsvIcon}
                  title="Connect Google Sheets"
                  sub="Mirror your log to a spreadsheet in your Drive"
                  chevron
                  locked={sheetsLocked}
                  onClick={doConnect}
                />
              ) : (
                <>
                  <SettingsItem
                    icon={BackupIcon}
                    title="Sync to Sheets now"
                    sub="Push your timeline to the spreadsheet"
                    chevron
                    locked={sheetsLocked}
                    onClick={doSync}
                  />
                  <SettingsItem
                    icon={RestoreIcon}
                    title="Re-import from Sheet"
                    sub="Read the spreadsheet back into your log"
                    chevron
                    locked={sheetsLocked}
                    onClick={doReimport}
                  />
                  <SettingsItem
                    icon={SignOutIcon}
                    title="Disconnect"
                    sub="Stop syncing — your spreadsheet stays in Drive"
                    locked={sheetsLocked}
                    onClick={doDisconnect}
                  />
                </>
              )}
            </>
          )}
        </section>

        {/* Session. Both controls need an account: there is no session to end and
            no server-side record to remove without one. The local timeline is
            still reachable — export it from Data above, or clear the site data. */}
        <section className="settings-section">
          {authed && (
            <>
              <SettingsItem
                icon={SignOutIcon}
                title="Sign out"
                sub="Your logs stay on this device"
                onClick={signOut}
              />
              <SettingsItem
                icon={DeleteIcon}
                title="Delete account & data"
                sub="Removes your account and wipes this device"
                danger
                onClick={() => setConfirmDelete(true)}
              />
            </>
          )}

          {/* Req 17.7 — the account was not deleted: say so, and offer the only
              control that repeats the request (nothing retries on its own) */}
          {accountDeleteError && (
            <>
              <div className="settings-hint">{accountDeleteError}</div>
              <SettingsItem
                icon={DeleteIcon}
                title="Try deleting the account again"
                sub="Repeat the request"
                danger
                onClick={() => setConfirmDelete(true)}
              />
            </>
          )}
        </section>

        {/* The full build id, not just the semver: it is what a bug report needs to
            be actionable, and what `/api/admin/metrics` groups a cohort by.
 
            Tapping it reveals the layout numbers. Not a hidden feature for its own
            sake — the app is installed on devices we cannot inspect, and "there is a
            gap at the bottom" is unfixable without knowing whether the viewport, the
            safe-area insets, or the app box is the one reporting a surprising value. */}
        <button
          className="settings-about settings-about-btn"
          onClick={() => setShowDiagnostics((v) => !v)}
          aria-expanded={showDiagnostics}
        >
          SnapGut {APP_BUILD}
        </button>
        {showDiagnostics && <LayoutDiagnostics />}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={onFilePicked}
      />

      {toast && <div className="toast">{toast}</div>}
      {busy && <div className="toast">{busy}</div>}

      {/* Req 18.6, 18.9 — the disclosure, shown on open and before the first enable */}
      {disclosure && (
        <div className="sheet-backdrop" onClick={() => setDisclosure(null)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <div className="detail-title">What SnapGut Cloud stores</div>
            <p className="confirm-copy">
              With Cloud sync on, this device uploads your structured log entries to SnapGut's own
              server storage: meals and their ingredients, symptoms and severities, Bristol stool
              scores, stress values, sleep values, and any note text you write.
            </p>
            <p className="confirm-copy">
              Meal photos never leave this device. Your data is only used to sync, restore, and
              delete your own timeline. You can erase everything the cloud holds at any time with
              “Delete cloud copy” in this section, and your on-device logs stay put when you do.
            </p>
            <button className="action-item" onClick={acknowledgeDisclosure}>
              <span className="ai-ico">
                <BackupIcon size={22} />
              </span>
              <div className="ai-title">
                {disclosure === "enable" ? "I understand — turn on Cloud sync" : "Got it"}
              </div>
            </button>
            <button className="action-cancel" onClick={() => setDisclosure(null)}>
              {disclosure === "enable" ? "Not now" : "Close"}
            </button>
          </div>
        </div>
      )}

      {/* Req 17.8 — no request is issued until the user confirms here */}
      {confirmCloudDelete && (
        <div className="sheet-backdrop" onClick={() => setConfirmCloudDelete(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <div className="detail-title">Delete the cloud copy?</div>
            <p className="confirm-copy">
              This permanently deletes every log entry and deletion record SnapGut Cloud holds for
              your account. The copy on this device is kept, and your account and Pro plan stay as
              they are. Entries that exist only on your other devices can't be recovered from the
              cloud afterwards — and Cloud sync is turned off here, so this device won't re-upload
              them.
            </p>
            <button className="action-item danger" onClick={reallyDeleteCloudCopy}>
              <span className="ai-ico">
                <DeleteIcon size={22} />
              </span>
              <div className="ai-title">Delete cloud copy</div>
            </button>
            <button className="action-cancel" onClick={() => setConfirmCloudDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="sheet-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <div className="detail-title">Delete account & all data?</div>
            <p className="confirm-copy">
              This permanently deletes your account and erases every log, photo, and
              backup reminder on this device. This can't be undone. Back up first if you
              want to keep your data.
            </p>
            <button className="action-item danger" onClick={reallyDelete}>
              <span className="ai-ico">
                <DeleteIcon size={22} />
              </span>
              <div className="ai-title">Delete everything</div>
            </button>
            <button className="action-cancel" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span className="sr-label">{label}</span>
      <span className="sr-value">{value}</span>
    </div>
  );
}

/**
 * A settings row. `locked` renders it non-interactive (Req 15.1): the row stays
 * in the accessibility tree and keeps its label, marked `aria-disabled`, and the
 * activation is dropped rather than dispatched — so a locked Sheets control
 * cannot reach Google, and the separate upgrade row beside it is the only live
 * control.
 */
function SettingsItem({
  icon: Icon,
  title,
  sub,
  onClick,
  chevron,
  accent,
  danger,
  locked,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  sub: string;
  onClick: () => void;
  chevron?: boolean;
  accent?: boolean;
  danger?: boolean;
  locked?: boolean;
}) {
  return (
    <button
      className={`settings-item${accent ? " accent" : ""}${danger ? " danger" : ""}${
        locked ? " locked" : ""
      }`}
      aria-disabled={locked || undefined}
      onClick={locked ? () => {} : onClick}
    >
      <span className="si-ico">
        <Icon size={20} />
      </span>
      <div className="si-body">
        <div className="si-title">{title}</div>
        <div className="si-sub">{sub}</div>
      </div>
      {chevron && (
        <span className="si-chev">
          <ChevronIcon size={18} />
        </span>
      )}
    </button>
  );
}

/**
 * A destination toggle. `locked` renders the switch as non-activatable (Req 1.2)
 * with `aria-disabled` rather than `disabled`, because a locked activation still
 * has to reach the upgrade flow (Req 1.10). `role="switch"` plus `aria-checked`
 * puts the on/off position in the accessibility tree, so it never rests on
 * colour (Req 12.10).
 */
function ToggleRow({
  title,
  sub,
  on,
  locked,
  onToggle,
}: {
  title: string;
  sub: string;
  on: boolean;
  locked?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`settings-item toggle-item${locked ? " locked" : ""}`}
      role="switch"
      aria-checked={on}
      aria-disabled={locked || undefined}
      onClick={onToggle}
    >
      <div className="si-body">
        <div className="si-title">{title}</div>
        <div className="si-sub">{sub}</div>
      </div>
      <span className={`si-switch${on ? " on" : ""}`} aria-hidden="true">
        <span className="si-knob" />
      </span>
    </button>
  );
}

function ThemeOption({
  icon: Icon,
  label,
  on,
  onClick,
}: {
  icon: ComponentType<IconProps>;
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`seg-btn theme-opt${on ? " on" : ""}`}
      onClick={onClick}
      aria-pressed={on}
    >
      <Icon size={18} />
      {label}
    </button>
  );
}
