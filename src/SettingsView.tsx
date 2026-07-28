import { useEffect, useRef, useState } from "react";
import { getEvents, toCSV } from "./db";
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
  getThemePref,
  setThemePref,
  type ThemePref,
} from "./theme";
import {
  BackIcon,
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

const APP_VERSION = "0.1.0";
const DB_NAME = "food-snap"; // internal storage key (kept for back-compat)

interface Props {
  entitlement: Entitlement | null;
  onClose: () => void;
  onUpgrade: () => void;
  onSignedOut: () => void;
  onChanged: () => void; // bump global reload after a restore
}

export default function SettingsView({
  entitlement,
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
  const fileRef = useRef<HTMLInputElement>(null);

  function chooseTheme(pref: ThemePref) {
    setTheme(pref);
    setThemePref(pref);
  }

  useEffect(() => {
    fetchMe().then((me) => me && setEmail(me.email));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

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
      const n = await importBackup(file);
      onChanged();
      setToast(`Restored ${n} item${n === 1 ? "" : "s"}`);
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

  async function reallyDelete() {
    setBusy("Deleting account…");
    try {
      await deleteAccount();
    } catch {
      // even if the server call fails, wipe local data and sign out
    }
    // Wipe local device data.
    try {
      indexedDB.deleteDatabase(DB_NAME);
    } catch {
      /* ignore */
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
        <button className="icon-round" onClick={onClose} aria-label="Back">
          <BackIcon size={22} />
        </button>
        <h1>Settings</h1>
        <div style={{ width: 36 }} />
      </div>

      <div className="settings-scroll">
        {/* Account */}
        <section className="settings-section">
          <div className="settings-label">Account</div>
          <div className="settings-card">
            <Row label="Email" value={email || "—"} />
            <div className="settings-divider" />
            <Row label="Plan" value={planLabel} />
            {!pro && (
              <>
                <div className="settings-divider" />
                <Row label="Free AI left" value={`${freeLeft} of ${entitlement?.freeAiLimit ?? 0}`} />
              </>
            )}
          </div>
          {pro ? (
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
          <SettingsItem
            icon={CsvIcon}
            title="Export as CSV"
            sub="Spreadsheet of your timeline"
            chevron
            onClick={exportCSV}
          />
        </section>

        {/* Session */}
        <section className="settings-section">
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
        </section>

        <div className="settings-about">SnapGut v{APP_VERSION}</div>
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
}: {
  icon: ComponentType<IconProps>;
  title: string;
  sub: string;
  onClick: () => void;
  chevron?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`settings-item${accent ? " accent" : ""}${danger ? " danger" : ""}`}
      onClick={onClick}
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
