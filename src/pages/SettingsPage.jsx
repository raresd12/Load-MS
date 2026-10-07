import { useRef, useState } from "react";
import { ChevronDown, Download, Trash2, Upload } from "lucide-react";
import { getLocalDateKey } from "../lib/date.js";
import {
  createLocalBackup,
  getTrackedStorageKeys,
  resetLocalAppData,
  restoreLocalBackup,
  SECRET_STORAGE_KEYS,
  clearSecret,
  validateLocalBackup,
} from "../lib/storage.js";

export default function SettingsPage() {
  const fileInputRef = useRef(null);
  const [exportMessage, setExportMessage] = useState("");
  const [exportError, setExportError] = useState("");
  const [importError, setImportError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [pendingImport, setPendingImport] = useState(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [resetMessage, setResetMessage] = useState("");
  const trackedKeys = getTrackedStorageKeys();

  function handleExportData() {
    setExportMessage("");
    setExportError("");

    try {
      const backup = createLocalBackup();
      const fileName = `rpe-tracker-backup-${getLocalDateKey()}.json`;
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setExportMessage(`Exported ${Object.keys(backup.data).length} data groups.`);
    } catch {
      setExportError("Could not export local data. Try again after refreshing the app.");
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];

    setImportError("");
    setImportMessage("");
    setPendingImport(null);

    if (!file) {
      return;
    }

    try {
      const backup = JSON.parse(await file.text());
      const validation = validateLocalBackup(backup);

      if (!validation.valid) {
        setImportError(validation.error);
        return;
      }

      setPendingImport({
        backup,
        fileName: file.name,
        validation,
      });
    } catch {
      setImportError("Could not read that file. Choose a valid JSON backup.");
    } finally {
      event.target.value = "";
    }
  }

  function handleConfirmImport() {
    if (!pendingImport) {
      return;
    }

    const result = restoreLocalBackup(pendingImport.backup);

    if (!result.valid) {
      setImportError(result.error);
      return;
    }

    setImportMessage("Backup imported. Reloading app data...");
    setPendingImport(null);
    window.setTimeout(() => window.location.reload(), 700);
  }

  function handleResetLocalData() {
    if (resetText !== "RESET") {
      setResetMessage("Type RESET to confirm local data reset.");
      return;
    }

    const result = resetLocalAppData();

    if (!result.ok) {
      setResetMessage(result.error);
      return;
    }

    // The Gemini key lives outside the tracked keys; a full reset should
    // still remove credentials from the device.
    clearSecret(SECRET_STORAGE_KEYS.geminiApiKey);
    setResetMessage("Local app data reset. Reloading default program...");
    window.setTimeout(() => window.location.reload(), 700);
  }

  return (
    <div className="space-y-4">
      <section className="card p-3 min-[430px]:p-4">
        <p className="label-accent">
          App Settings
        </p>
        <h2 className="mt-1 text-[22px] font-semibold text-text-1">Settings</h2>
        <div className="mt-4 rounded-block bg-accent-tint px-3 py-3">
          <p className="text-sm font-semibold text-accent-soft">Guest Mode</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-accent-soft">
            Your data is saved only on this device/browser.
          </p>
        </div>
      </section>

      <section className="card p-3 min-[430px]:p-4">
        <p className="text-sm font-semibold text-text-1">Backup</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-text-2">
          Export a JSON backup before switching phones, clearing browser data, or testing risky changes.
        </p>
        <button
          type="button"
          onClick={handleExportData}
          className="focus-ring btn btn-primary mt-4 flex min-h-12 w-full items-center justify-center gap-2"
        >
          <Download aria-hidden="true" size={18} />
          Export Data
        </button>
        {exportMessage && (
          <p role="status" className="mt-3 rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold text-accent-soft">
            {exportMessage}
          </p>
        )}
        {exportError && (
          <p role="alert" className="mt-3 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
            {exportError}
          </p>
        )}
      </section>

      <section className="card p-3 min-[430px]:p-4">
        <p className="text-sm font-semibold text-text-1">Import</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-text-2">
          Choose a backup exported from this app. You will confirm before anything is restored.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="focus-ring btn btn-secondary mt-4 flex min-h-12 w-full items-center justify-center gap-2"
        >
          <Upload aria-hidden="true" size={18} />
          Import Data
        </button>

        {importError && (
          <p role="alert" className="mt-3 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
            {importError}
          </p>
        )}

        {importMessage && (
          <p role="status" className="mt-3 rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold text-accent-soft">
            {importMessage}
          </p>
        )}

        {pendingImport && (
          <div className="mt-4 rounded-block bg-warn-tint p-3">
            <p className="text-sm font-semibold text-warn">Confirm import</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-warn">
              Import `{pendingImport.fileName}` and replace local RPE Tracker data on this device?
            </p>
            <p className="mt-2 text-xs font-semibold text-warn">
              Recognized data groups: {pendingImport.validation.recognizedKeys.length}
              {pendingImport.validation.ignoredKeys.length
                ? ` | Ignored unknown groups: ${pendingImport.validation.ignoredKeys.length}`
                : ""}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleConfirmImport}
                className="focus-ring btn btn-primary min-h-11 px-3 text-sm"
              >
                Import Backup
              </button>
              <button
                type="button"
                onClick={() => setPendingImport(null)}
                className="focus-ring btn btn-secondary min-h-11 px-3 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-block bg-bad-tint p-3 min-[430px]:p-4">
        <div className="flex items-start gap-3">
          <Trash2 aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-bad" />
          <div>
            <p className="text-sm font-semibold text-bad">Reset Local Data</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-bad">
              This deletes local app data from this device/browser. After reload, the default program is seeded again.
            </p>
          </div>
        </div>
        {!isResetOpen ? (
          <button
            type="button"
            onClick={() => {
              setIsResetOpen(true);
              setResetMessage("");
            }}
            className="focus-ring btn btn-danger mt-4 min-h-12 w-full"
          >
            Reset Local Data
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="label mb-2 text-bad">
                Type RESET to confirm
              </span>
              <input
                type="text"
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                className="focus-ring min-h-12 field w-full"
                placeholder="RESET"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={resetText !== "RESET"}
                onClick={handleResetLocalData}
                className={`focus-ring btn btn-danger min-h-12 px-4 text-sm ${
                  resetText === "RESET" ? "border-bad" : ""
                }`}
              >
                Confirm Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsResetOpen(false);
                  setResetText("");
                  setResetMessage("");
                }}
                className="focus-ring min-h-12 btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {resetMessage && (
          <p role="alert" className="mt-3 rounded-control bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
            {resetMessage}
          </p>
        )}
      </section>

      <details className="card py-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text-1">
          Local data groups included in backups
          <ChevronDown aria-hidden="true" size={16} className="disclosure-chevron text-text-2" />
        </summary>
        <div className="mt-2 grid gap-1">
          {trackedKeys.map((key) => (
            <code
              key={key}
              className="card-inset break-all px-2 py-1 font-mono text-xs text-text-2"
            >
              {key}
            </code>
          ))}
        </div>
      </details>
    </div>
  );
}
