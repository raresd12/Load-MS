import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { ACCOUNT_GUEST_SENTENCE, describeAccountError, describeSyncStatus } from "../../lib/accountView.js";
import AccountAuthForms from "./AccountAuthForms.jsx";
import AccountLinkPreview from "./AccountLinkPreview.jsx";
import AccountSignedInPanel from "./AccountSignedInPanel.jsx";
import { getSyncController } from "./syncController.js";

// Settings "Account and sync" card (Phase H6, decisions H6-2, H6-9, H6-11,
// H6-24 to H6-27). Guest -> sign in / create account / recover -> (the
// recovery code, once) -> link preview -> signed-in panel. The card only
// reads the engine; every write is the engine's.

const STATUS_REFRESH_MS = 30000;

function RecoveryCodeNotice({ code, onDone }) {
  const [copyNote, setCopyNote] = useState("");

  async function handleCopy() {
    try {
      await globalThis.navigator?.clipboard?.writeText(code);
      setCopyNote("Copied. Paste it somewhere safe, like a password manager.");
    } catch {
      setCopyNote("Could not copy. Select the code and copy it by hand.");
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-block bg-warn-tint p-3">
      <p className="text-sm font-semibold text-warn">Save your recovery code</p>
      <p className="text-sm font-medium leading-6 text-warn">
        This code is the only way back into the account if you forget your password. It is shown once and is not
        stored on this device.
      </p>
      <p className="card-inset select-all break-all px-3 py-3 text-center font-mono text-base font-semibold text-text-1">
        {code}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={handleCopy} className="focus-ring btn btn-secondary min-h-11 px-3 text-sm">
          Copy
        </button>
        <button type="button" onClick={onDone} className="focus-ring btn btn-primary min-h-11 px-3 text-sm">
          I saved it
        </button>
      </div>
      {copyNote && (
        <p role="status" className="text-sm font-medium text-warn">
          {copyNote}
        </p>
      )}
    </div>
  );
}

export default function AccountSyncCard({ onExportData, onSignedInChange }) {
  const [controller] = useState(() => getSyncController());
  const { engine, scheduler } = controller;
  const [snapshot, setSnapshot] = useState(() => scheduler.getSnapshot());
  const [now, setNow] = useState(() => Date.now());
  const [recoveryCode, setRecoveryCode] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => scheduler.subscribe(setSnapshot), [scheduler]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
      setSnapshot(scheduler.getSnapshot());
    }, STATUS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [scheduler]);

  const status = snapshot.status;

  useEffect(() => {
    onSignedInChange?.(Boolean(status.signedIn));
  }, [status.signedIn, onSignedInChange]);

  function refresh() {
    setNow(Date.now());
    setSnapshot(scheduler.getSnapshot());
  }

  function handleSignedIn({ recoveryCode: code }) {
    setNotice("");
    setRecoveryCode(code || null);
    scheduler.reset();
    refresh();
  }

  function handleLinked(result) {
    scheduler.reset();
    refresh();
    setNotice(
      result?.status === "synced"
        ? "This device is linked and synced."
        : "This device is linked. The first sync did not finish; see the status below.",
    );
  }

  function handleSignedOut(text) {
    setRecoveryCode(null);
    setNotice(text || "Signed out. Your data is still on this device.");
    scheduler.reset();
    refresh();
  }

  let view = "guest";

  if (recoveryCode) {
    view = "recovery";
  } else if (status.signedIn && !status.linked) {
    view = "link";
  } else if (status.signedIn) {
    view = "account";
  }

  const guestLine = describeSyncStatus({ status, now });

  return (
    <section className="card p-3 min-[430px]:p-4" aria-labelledby="account-sync-title">
      <div className="flex items-start gap-3">
        <Cloud aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-accent-soft" />
        <div className="min-w-0">
          <p className="label-accent">Private sync</p>
          <h3 id="account-sync-title" className="mt-1 text-base font-semibold text-text-1">
            Account and sync
          </h3>
          <p className="mt-1 text-sm leading-6 text-text-2">{ACCOUNT_GUEST_SENTENCE}</p>
        </div>
      </div>

      {!controller.configured && view === "guest" && (
        <p className="mt-3 rounded-block bg-warn-tint px-3 py-2 text-sm font-medium text-warn">
          Sync is not set up in this build of the app. Everything keeps working on this device.
        </p>
      )}

      {notice && (
        <p role="status" className="mt-3 rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold text-accent-soft">
          {notice}
        </p>
      )}

      {view === "guest" && status.lastError?.kind === "unauthorized" && (
        <p role="status" className="mt-3 rounded-block bg-warn-tint px-3 py-2 text-sm font-medium text-warn">
          {guestLine.text}
        </p>
      )}

      {view === "guest" && (
        <AccountAuthForms engine={engine} initialUsername={status.username ?? ""} onSignedIn={handleSignedIn} />
      )}

      {view === "recovery" && <RecoveryCodeNotice code={recoveryCode} onDone={() => setRecoveryCode(null)} />}

      {view === "link" && status.lastError?.code === "epoch_changed" && (
        <p role="status" className="mt-3 rounded-block bg-warn-tint px-3 py-2 text-sm font-medium text-warn">
          {describeAccountError(status.lastError)}
        </p>
      )}

      {view === "link" && (
        <AccountLinkPreview
          engine={engine}
          username={status.username}
          onExportData={onExportData}
          onLinked={handleLinked}
          onCancelled={() => handleSignedOut("Not linked. You are signed out and nothing on this device changed.")}
        />
      )}

      {view === "account" && (
        <AccountSignedInPanel
          engine={engine}
          scheduler={scheduler}
          snapshot={snapshot}
          now={now}
          onExportData={onExportData}
          onSignedOut={handleSignedOut}
        />
      )}
    </section>
  );
}
