import { useRef, useState } from "react";
import { Download, Trash2, Upload } from "lucide-react";
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
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          App Settings
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Settings</h2>
        <div className="mt-4 rounded-[8px] border border-lime-300/40 bg-lime-300/10 px-3 py-3">
          <p className="text-sm font-black text-lime-100">Guest Mode</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-lime-100/90">
            Your data is saved only on this device/browser.
          </p>
        </div>
      </section>

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-sm font-black text-white">Backup</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-zinc-400">
          Export a JSON backup before switching phones, clearing browser data, or testing risky changes.
        </p>
        <button
          type="button"
          onClick={handleExportData}
          className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
        >
          <Download aria-hidden="true" size={18} />
          Export Data
        </button>
        {exportMessage && (
          <p role="status" className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100">
            {exportMessage}
          </p>
        )}
        {exportError && (
          <p role="alert" className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100">
            {exportError}
          </p>
        )}
      </section>

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-sm font-black text-white">Import</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-zinc-400">
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
          className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800"
        >
          <Upload aria-hidden="true" size={18} />
          Import Data
        </button>

        {importError && (
          <p role="alert" className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100">
            {importError}
          </p>
        )}

        {importMessage && (
          <p role="status" className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100">
            {importMessage}
          </p>
        )}

        {pendingImport && (
          <div className="mt-4 rounded-[8px] border border-amber-300/50 bg-amber-300/10 p-3">
            <p className="text-sm font-black text-amber-100">Confirm import</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-amber-100/90">
              Import `{pendingImport.fileName}` and replace local RPE Tracker data on this device?
            </p>
            <p className="mt-2 text-xs font-bold text-amber-100/80">
              Recognized data groups: {pendingImport.validation.recognizedKeys.length}
              {pendingImport.validation.ignoredKeys.length
                ? ` | Ignored unknown groups: ${pendingImport.validation.ignoredKeys.length}`
                : ""}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleConfirmImport}
                className="focus-ring min-h-11 rounded-[8px] bg-amber-300 px-3 text-sm font-black text-zinc-950"
              >
                Import Backup
              </button>
              <button
                type="button"
                onClick={() => setPendingImport(null)}
                className="focus-ring min-h-11 rounded-[8px] border border-amber-300/60 px-3 text-sm font-black text-amber-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-[8px] border border-red-400/40 bg-red-400/10 p-3 min-[430px]:p-4">
        <div className="flex items-start gap-3">
          <Trash2 aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-red-200" />
          <div>
            <p className="text-sm font-black text-red-100">Reset Local Data</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-red-100/90">
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
            className="focus-ring mt-4 min-h-12 w-full rounded-[8px] border border-red-300/70 px-4 text-sm font-black text-red-100 hover:bg-red-300/10"
          >
            Reset Local Data
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-red-100/80">
                Type RESET to confirm
              </span>
              <input
                type="text"
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                className="focus-ring min-h-12 w-full rounded-[8px] border border-red-300/60 bg-[#111111] px-3 text-base font-black text-white"
                placeholder="RESET"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={resetText !== "RESET"}
                onClick={handleResetLocalData}
                className={`focus-ring min-h-12 rounded-[8px] px-4 text-sm font-black ${
                  resetText === "RESET"
                    ? "bg-red-300 text-zinc-950"
                    : "cursor-not-allowed bg-red-300/20 text-red-100/50"
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
                className="focus-ring min-h-12 rounded-[8px] border border-red-300/60 px-4 text-sm font-black text-red-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {resetMessage && (
          <p role="alert" className="mt-3 rounded-[8px] bg-red-300/10 px-3 py-2 text-sm font-bold text-red-100">
            {resetMessage}
          </p>
        )}
      </section>

      <details className="rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-black text-zinc-100">
          Local data groups included in backups
        </summary>
        <div className="mt-2 grid gap-1">
          {trackedKeys.map((key) => (
            <code
              key={key}
              className="break-all rounded-[8px] bg-[#111111] px-2 py-1 text-xs font-bold text-zinc-300"
            >
              {key}
            </code>
          ))}
        </div>
      </details>
    </div>
  );
}
