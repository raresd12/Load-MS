import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  describeAccountError,
  describeKeptVersion,
  describeMassDelete,
  describeSyncStatus,
  validateAccountForm,
} from "../../lib/accountView.js";

// The signed-in, linked device (decisions H6-2, H6-3, H6-8, H6-10, H6-11):
// the status line, Sync now, the mass-delete question, the kept versions and
// the account actions. Every success message follows a durable result.

const STATUS_PILL = {
  good: "pill pill-good",
  warn: "pill pill-warn",
  bad: "pill pill-bad",
  neutral: "pill",
};

const KEPT_PAGE_SIZE = 10;

function AccountPasswordInput({ id, label, autoComplete, value, onChange }) {
  return (
    <label htmlFor={id} className="block">
      <span className="label mb-2 block">{label}</span>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring field min-h-11 w-full"
      />
    </label>
  );
}

// The account's username, read-only and visually hidden, so a password
// manager knows which saved login a password form belongs to (decision H6-41).
function AccountUsernameField({ username }) {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={username || ""}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
    />
  );
}

export default function AccountSignedInPanel({ engine, scheduler, snapshot, now, onExportData, onSignedOut }) {
  const status = snapshot.status;
  const lastResult = snapshot.lastResult;
  const line = describeSyncStatus({ status, lastResult, online: snapshot.online, now });
  const massDelete = lastResult?.status === "needs-confirmation" ? lastResult : null;
  const [kept, setKept] = useState(() => engine.listConflicts());
  const [keptLimit, setKeptLimit] = useState(KEPT_PAGE_SIZE);
  const [keptError, setKeptError] = useState("");
  const [panel, setPanel] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");

  useEffect(() => {
    setKept(engine.listConflicts());
  }, [engine, snapshot]);

  function openPanel(next) {
    setPanel((current) => (current === next ? "" : next));
    setError("");
    setMessage("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setDeletePassword("");
  }

  async function syncNow(confirmMassDelete = false, restoreDeletes = false) {
    setError("");
    setMessage("");
    await scheduler.run("manual", { confirmMassDelete, restoreDeletes });
  }

  function handleKept(entry, keep) {
    setKeptError("");
    const result = keep ? engine.keepConflictVersion(entry.id) : engine.discardConflict(entry.id);

    if (!result?.ok) {
      setKeptError(describeAccountError(result?.error));
    }

    setKept(engine.listConflicts());
    scheduler.notify();
  }

  async function handleSignOut(everywhere) {
    if (pending) {
      return;
    }

    setPending(everywhere ? "signOutAll" : "signOut");
    setError("");
    const result = await engine.signOut({ everywhere });
    setPending("");
    scheduler.reset();
    onSignedOut?.(
      result.remoteOk || !everywhere
        ? "Signed out. Your data is still on this device."
        : `Signed out on this device. Other devices could not be signed out now: ${describeAccountError(result.error)}`,
    );
  }

  async function handleChangePassword(event) {
    event.preventDefault();
    const checked = validateAccountForm("changePassword", {
      password: currentPassword,
      newPassword,
      confirmPassword,
    });

    if (!checked.ok) {
      setError(checked.error);
      return;
    }

    setPending("password");
    setError("");
    const result = await engine.changePassword(checked.values);
    setPending("");

    if (!result?.ok) {
      setError(describeAccountError(result?.error));
      scheduler.notify();
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPanel("");
    setMessage("Password changed. Your other devices are signed out.");
  }

  async function handleDeleteAccount(event) {
    event.preventDefault();
    const checked = validateAccountForm("deleteAccount", { password: deletePassword });

    if (!checked.ok) {
      setError(checked.error);
      return;
    }

    setPending("delete");
    setError("");
    const result = await engine.deleteAccount(checked.values);
    setPending("");

    if (!result?.ok) {
      setError(describeAccountError(result?.error));
      scheduler.notify();
      return;
    }

    setDeletePassword("");
    scheduler.reset();
    onSignedOut?.("Account deleted. Your data is still on this device, in guest mode.");
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="card-inset px-3 py-3">
        <p className="text-sm font-semibold text-text-1">
          Signed in as <span className="text-accent-soft">{status.username || "your account"}</span>
        </p>
        <p role="status" aria-live="polite" className="mt-2">
          <span className={STATUS_PILL[line.tone] ?? STATUS_PILL.neutral}>{line.text}</span>
        </p>
        <button
          type="button"
          disabled={status.running}
          onClick={() => syncNow(false)}
          className="focus-ring btn btn-primary mt-3 flex min-h-12 w-full items-center justify-center gap-2"
        >
          <RefreshCw aria-hidden="true" size={18} />
          {status.running ? "Syncing..." : "Sync now"}
        </button>
      </div>

      {massDelete && (
        <div role="alert" className="rounded-block bg-warn-tint p-3">
          <p className="text-sm font-semibold text-warn">Confirm deletes</p>
          <p className="mt-1 text-sm font-medium leading-6 text-warn">{describeMassDelete(massDelete)}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={status.running}
              onClick={() => syncNow(false, true)}
              className="focus-ring btn btn-primary min-h-11 px-3 text-sm sm:col-span-2"
            >
              Bring them back from the account
            </button>
            <button
              type="button"
              onClick={() => onExportData?.()}
              className="focus-ring btn btn-secondary flex min-h-11 items-center justify-center gap-2 px-3 text-sm"
            >
              <Download aria-hidden="true" size={16} />
              Export Data
            </button>
            <button
              type="button"
              disabled={status.running}
              onClick={() => syncNow(true)}
              className="focus-ring btn btn-danger min-h-11 px-3 text-sm"
            >
              Delete them from the account
            </button>
          </div>
        </div>
      )}

      {kept.length > 0 && (
        <div>
          <p className="label">Kept versions</p>
          <p className="mt-1 text-xs font-medium leading-5 text-text-3">
            When the same record changed in two places, the other version is kept here. Keep this version makes it
            live again; Discard removes the copy.
          </p>
          <ul className="mt-2 space-y-2">
            {kept.slice(0, keptLimit).map((entry) => {
              const text = describeKeptVersion(entry, now);
              return (
                <li key={entry.id} className="card-inset px-3 py-2">
                  <p className="break-words text-sm font-semibold text-text-1">{text.title}</p>
                  <p className="mt-0.5 text-xs font-medium leading-5 text-text-2">{text.detail}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleKept(entry, true)}
                      className="focus-ring btn btn-secondary btn-sm min-h-11"
                    >
                      Keep this version
                    </button>
                    <button
                      type="button"
                      onClick={() => handleKept(entry, false)}
                      className="focus-ring btn btn-ghost btn-sm min-h-11"
                    >
                      Discard
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {kept.length > keptLimit && (
            <button
              type="button"
              onClick={() => setKeptLimit((limit) => limit + KEPT_PAGE_SIZE)}
              className="focus-ring btn btn-ghost btn-sm mt-2 min-h-11"
            >
              Show more ({kept.length - keptLimit} left)
            </button>
          )}
          {keptError && (
            <p role="alert" className="mt-2 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
              {keptError}
            </p>
          )}
        </div>
      )}

      <div>
        <p className="label">Account</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => handleSignOut(false)}
            className="focus-ring btn btn-secondary min-h-11 px-3 text-sm"
          >
            {pending === "signOut" ? "Signing out..." : "Sign out"}
          </button>
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => handleSignOut(true)}
            className="focus-ring btn btn-secondary min-h-11 px-3 text-sm"
          >
            {pending === "signOutAll" ? "Signing out..." : "Sign out everywhere"}
          </button>
          <button
            type="button"
            aria-expanded={panel === "password"}
            onClick={() => openPanel("password")}
            className="focus-ring btn btn-ghost min-h-11 px-3 text-sm"
          >
            Change password
          </button>
          <button
            type="button"
            aria-expanded={panel === "delete"}
            onClick={() => openPanel("delete")}
            className="focus-ring btn btn-ghost min-h-11 px-3 text-sm"
          >
            Delete account
          </button>
        </div>
        <p className="mt-2 text-xs font-medium leading-5 text-text-3">
          Signing out keeps everything on this device. Sign out everywhere also signs out your other devices.
        </p>
      </div>

      {panel === "password" && (
        <form className="card-inset space-y-3 px-3 py-3" onSubmit={handleChangePassword} noValidate>
          <p className="text-sm font-semibold text-text-1">Change password</p>
          <AccountUsernameField username={status.username} />
          <AccountPasswordInput
            id="account-current-password"
            label="Current password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={setCurrentPassword}
          />
          <AccountPasswordInput
            id="account-next-password"
            label="New password"
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
          />
          <AccountPasswordInput
            id="account-next-password-repeat"
            label="Repeat new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
          />
          <button type="submit" disabled={Boolean(pending)} className="focus-ring btn btn-primary min-h-11 w-full">
            {pending === "password" ? "Saving..." : "Change password"}
          </button>
        </form>
      )}

      {panel === "delete" && (
        <form className="rounded-block bg-bad-tint space-y-3 p-3" onSubmit={handleDeleteAccount} noValidate>
          <p className="text-sm font-semibold text-bad">Delete account</p>
          <p className="text-sm font-medium leading-6 text-bad">
            This deletes the account and its data from the sync server at once. The server's daily backups still hold a
            copy for up to 14 days, until they rotate out. The data on this device stays, and the app continues in guest
            mode. Your other devices keep their own copy too.
          </p>
          <AccountUsernameField username={status.username} />
          <AccountPasswordInput
            id="account-delete-password"
            label="Password"
            autoComplete="current-password"
            value={deletePassword}
            onChange={setDeletePassword}
          />
          <button type="submit" disabled={Boolean(pending)} className="focus-ring btn btn-danger min-h-11 w-full">
            {pending === "delete" ? "Deleting..." : "Delete account"}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-block bg-good-tint px-3 py-2 text-sm font-semibold text-good">
          {message}
        </p>
      )}
    </div>
  );
}
