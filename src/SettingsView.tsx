import { useEffect, useRef, useState } from "react";
import { getEvents, getMeta, toCSV } from "./db";
import { getSymptom } from "./symptoms";
import {
  clearToken,
  fetchMe,
  deleteAccount,
} from "./session";
import { exportBackup, importBackup, getLastBackupAt, daysSince } from "./backup";
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
  isDestinationEnabled,
  setDestinationEnabled,
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
  BackupIcon,
  CameraIcon,
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
import InstallSteps from "./InstallSteps";
import CameraPermissionSheet from "./CameraPermissionSheet";
import { cameraHintApplies } from "./cameraPermission";
import { canInstall, isIOS, promptInstall, subscribeInstall } from "./installPrompt";

const DB_NAME = "food-snap";

const ACCOUNT_DELETE_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const CLOUD_STATE_WORDS: Record<SyncState["state"], string> = {
  off: "Off",
  idle: "Waiting",
  syncing: "Syncing",
  synced: "Synced",
  error: "Error",
};

function syncTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function cloudStatusMessage(s: SyncState): string {
  switch (s.state) {
    case "off":
      return "Cloud sync is off. Your logs stay on this device.";
    case "idle":
      if (s.lastSyncAt === null) return "No sync has completed yet.";
      return s.pending > 0
        ? `${plural(s.pending, "change", "changes")} waiting to sync · last synced ${syncTime(s.lastSyncAt)}`
        : `Waiting to sync · last synced ${syncTime(s.lastSyncAt)}`;
    case "syncing":
      return "Syncing your timeline with SnapGut Cloud…";
    case "synced":
      return s.skipped > 0
        ? `Last synced ${syncTime(s.lastSyncAt)} · ${plural(s.skipped, "record", "records")} skipped as unreadable`
        : `Last synced ${syncTime(s.lastSyncAt)}`;
    case "error":
      return s.lastSyncAt === null
        ? s.message
        : `${s.message} Last synced ${syncTime(s.lastSyncAt)}.`;
  }
}

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
  /** Whether a session is held. */
  authed?: boolean;
  onNeedSignIn?: () => void;
  onClose: () => void;
  onSignedOut: () => void;
  onChanged: () => void;
}

export default function SettingsView({
  authed = true,
  onNeedSignIn,
  onClose,
  onSignedOut,
  onChanged,
}: Props) {
  const [email, setEmail] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastBackup, setLastBackup] = useState<number | null>(getLastBackupAt());
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const [cloudState, setCloudState] = useState<SyncState>(() => getSyncState());
  const [cloudEnabled, setCloudEnabled] = useState(() => isDestinationEnabled("cloud"));
  const [insightsStored, setInsightsStored] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [installOffer, setInstallOffer] = useState(() => canInstall());
  const [installSteps, setInstallSteps] = useState(false);
  const [cameraSheet, setCameraSheet] = useState(false);

  useEffect(() => subscribeInstall(() => setInstallOffer(canInstall())), []);

  async function addToHomeScreen() {
    if (isIOS() || !(await promptInstall())) setInstallSteps(true);
  }

  const [cloudUnsaved, setCloudUnsaved] = useState(false);
  const [restoreSummary, setRestoreSummary] = useState<
    { merged: number; skipped: number } | null
  >(null);
  const [disclosure, setDisclosure] = useState<"notice" | "enable" | null>(null);
  const [confirmCloudDelete, setConfirmCloudDelete] = useState(false);
  const [cloudDeleteError, setCloudDeleteError] = useState<string | null>(null);
  const [accountDeleteError, setAccountDeleteError] = useState<string | null>(null);
  const prevCloudState = useRef<SyncState>(cloudState);
  const fileRef = useRef<HTMLInputElement>(null);

  function chooseTheme(pref: ThemePref) {
    setTheme(pref);
    setThemePref(pref);
  }

  useEffect(() => {
    void listInsights().then((list) => setInsightsStored(list.length > 0));
  }, []);

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me) return;
      setEmail(me.email);
      if (!hasAckedDisclosure(me.email)) setDisclosure((d) => d ?? "notice");
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    setCloudState(getSyncState());
    hydrateSyncState().then(() => setCloudState(getSyncState()));
    return subscribeCloud((next) => {
      const prev = prevCloudState.current;
      prevCloudState.current = next;
      if (prev.state === "syncing" && prev.restore !== null && next.state !== "syncing") {
        setRestoreSummary({
          merged: prev.restore.merged,
          skipped: next.state === "synced" ? next.skipped : 0,
        });
      }
      setCloudState(next);
    });
  }, []);

  useEffect(() => {
    function read() {
      const s = getSyncSettings();
      setCloudEnabled(s.enabled.cloud);
      setCloudUnsaved(s.persistFailed === "cloud");
    }
    read();
    return subscribeSyncSettings(read);
  }, []);

  const backupStatus =
    lastBackup === null
      ? "Never backed up"
      : daysSince(lastBackup) === 0
      ? "Backed up today"
      : `Last backup ${daysSince(lastBackup)}d ago`;

  const cloudWord = CLOUD_STATE_WORDS[cloudState.state];
  const cloudMessage = cloudStatusMessage(cloudState);

  async function toggleCloud() {
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
      const cursor = await getMeta<string>("cursor");
      if (!cursor) await enqueueEntireLocalStore();
    } catch {
      /* the next Sync_Cycle re-derives what is still pending */
    }
    setBusy(null);
    void requestSync("manual");
  }

  async function acknowledgeDisclosure() {
    const mode = disclosure;
    if (email) ackDisclosure(email);
    setDisclosure(null);
    if (mode === "enable") await enableCloud();
  }

  function syncCloudNow() {
    setToast("Syncing to SnapGut Cloud…");
    void requestSync("manual");
  }

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

  function signOut() {
    clearToken();
    onSignedOut();
  }

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
      setBusy(null);
      setAccountDeleteError(
        "Your account wasn't deleted. Nothing on this device changed — every log, photo, " +
          "and sync setting is still here and you're still signed in. You can try again below.",
      );
      setToast("Couldn't delete the account.");
      return;
    }

    try {
      indexedDB.deleteDatabase(DB_NAME);
    } catch {
      /* ignore */
    }
    try {
      setDestinationEnabled("cloud", false);
    } catch {
      /* best-effort */
    }
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
          </div>
          {!authed && (
            <SettingsItem
              icon={InsightsIcon}
              title="Sign in"
              sub="Keeps your logs on this device — unlocks AI recognition & insights"
              chevron
              accent
              onClick={() => onNeedSignIn?.()}
            />
          )}
        </section>

        {/* Home Screen */}
        {installOffer && (
          <section className="settings-section">
            <div className="settings-label">Home Screen</div>
            <SettingsItem
              icon={BackupIcon}
              title="Add SnapGut to your Home Screen"
              sub="Opens straight to the camera, and keeps your log from being cleared"
              chevron
              onClick={addToHomeScreen}
            />
            <div className="settings-hint">
              Your log lives on this device. A browser can clear a site's data after a
              stretch of not visiting — being installed is what prevents that.
            </div>
          </section>
        )}

        {/* Camera */}
        {cameraHintApplies() && (
          <section className="settings-section">
            <div className="settings-label">Camera</div>
            <SettingsItem
              icon={CameraIcon}
              title="iOS asking for the camera every launch?"
              sub="Set it to Allow once in Safari and it sticks"
              chevron
              onClick={() => setCameraSheet(true)}
            />
          </section>
        )}

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

          {/* SnapGut Cloud */}
          <div className="settings-label">SnapGut Cloud</div>
          <ToggleRow
            title="Sync with SnapGut Cloud"
            sub="Keep your timeline on every device you sign in to"
            on={cloudEnabled}
            onToggle={toggleCloud}
          />

          <div className="settings-card cloud-status" role="status" aria-live="polite">
            <div className="cloud-state-line">
              <span className={`cloud-dot ${cloudState.state}`} aria-hidden="true" />
              <span className="cloud-state-word">{cloudWord}</span>
            </div>
            <p className="cloud-state-msg">{cloudMessage}</p>
            {cloudState.state === "syncing" && cloudState.restore !== null && (
              <p className="cloud-state-msg">
                Restoring your timeline · {plural(cloudState.restore.merged, "event", "events")}{" "}
                merged so far
              </p>
            )}
          </div>

          {cloudUnsaved && (
            <div className="settings-hint">
              This device couldn't save the Cloud sync setting, so it may not stick after a
              restart.
            </div>
          )}

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

          {!authed ? (
            <SettingsItem
              icon={InsightsIcon}
              title="Sign in to use Cloud sync"
              sub="Cloud sync needs an account — your logs stay on this device until you turn it on"
              chevron
              accent
              onClick={() => onNeedSignIn?.()}
            />
          ) : null}

          {cloudEnabled && (
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

        </section>

        {/* Session */}
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

      {installSteps && (
        <InstallSteps
          onClose={() => setInstallSteps(false)}
          onDone={() => setInstallSteps(false)}
        />
      )}

      {cameraSheet && <CameraPermissionSheet onClose={() => setCameraSheet(false)} />}

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
              "Delete cloud copy" in this section, and your on-device logs stay put when you do.
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

      {confirmCloudDelete && (
        <div className="sheet-backdrop" onClick={() => setConfirmCloudDelete(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            <div className="detail-title">Delete the cloud copy?</div>
            <p className="confirm-copy">
              This permanently deletes every log entry and deletion record SnapGut Cloud holds for
              your account. The copy on this device is kept, and your account stays as
              it is. Entries that exist only on your other devices can't be recovered from the
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
