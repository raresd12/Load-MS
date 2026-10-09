import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { buildLinkPreviewModel, describeAccountError } from "../../lib/accountView.js";

// The first link of a device (decision H6-9): counts per collection in plain
// words, Export Data first, then Merge, Use the account's data, or Cancel.
// Nothing is written until the person chooses.

export default function AccountLinkPreview({ engine, username, onExportData, onLinked, onCancelled }) {
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [exportNote, setExportNote] = useState("");
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setLoadError("");
    engine
      .buildLinkPreview()
      .then((result) => {
        if (!active) {
          return;
        }

        if (result?.ok) {
          setPreview(buildLinkPreviewModel(result));
        } else {
          setPreview(null);
          setLoadError(describeAccountError(result?.error) || "Sign in again to link this device.");
        }
      })
      .catch(() => {
        if (active) {
          setLoadError("Could not compare this device with the account. Try again.");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [engine, reloadCount]);

  function handleExport() {
    const ok = onExportData?.();
    setExportNote(
      ok
        ? "Backup downloaded. Keep it until you have checked your data after linking."
        : "The backup could not be created. See the Backup section below.",
    );
  }

  async function choose(choice) {
    if (pending) {
      return;
    }

    setPending(choice);
    setError("");
    let result;

    try {
      result = await engine.applyLink(choice);
    } catch {
      result = { status: "error", error: { kind: "server", code: "internal" } };
    }

    setPending("");

    if (choice === "cancel") {
      onCancelled?.();
      return;
    }

    if (result?.linked) {
      onLinked?.(result);
      return;
    }

    if (result?.status === "busy") {
      setError("Another tab is syncing. Try again in a moment.");
      return;
    }

    if (result?.status === "signed-out") {
      onCancelled?.(result);
      return;
    }

    setError(describeAccountError(result?.error) || "Linking did not finish. Nothing on this device was changed.");
    setReloadCount((count) => count + 1);
  }

  return (
    <div className="mt-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-text-1">Link this device to {username || "your account"}</p>
        <p className="mt-1 text-sm leading-6 text-text-2">
          Here is what this device and the account hold. Nothing changes until you choose.
        </p>
      </div>

      {loading && (
        <p role="status" className="card-inset px-3 py-2 text-sm font-medium text-text-2">
          Comparing this device with the account...
        </p>
      )}

      {loadError && (
        <div role="alert" className="rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => setReloadCount((count) => count + 1)}
            className="focus-ring btn btn-secondary btn-sm mt-2 min-h-11"
          >
            Try again
          </button>
        </div>
      )}

      {preview && (
        <>
          <ul className="space-y-2" aria-label="What this device and the account hold">
            {preview.rows.length ? (
              preview.rows.map((row) => (
                <li key={row.name} className="card-inset px-3 py-2">
                  <p className="text-sm font-semibold text-text-1">{row.label}</p>
                  <p className="mt-0.5 text-xs font-medium leading-5 text-text-2">{row.parts.join(", ")}</p>
                </li>
              ))
            ) : (
              <li className="card-inset px-3 py-2 text-sm font-medium text-text-2">
                Neither this device nor the account holds any data yet.
              </li>
            )}
          </ul>
          {preview.skippedText && <p className="text-xs font-medium leading-5 text-text-3">{preview.skippedText}</p>}
        </>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleExport}
          className="focus-ring btn btn-secondary flex min-h-12 w-full items-center justify-center gap-2"
        >
          <Download aria-hidden="true" size={18} />
          Export Data
        </button>
        <p className="text-xs font-medium leading-5 text-text-3">
          Export a backup first, so you can always go back to what is on this device now.
        </p>
        {exportNote && (
          <p role="status" className="rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold text-accent-soft">
            {exportNote}
          </p>
        )}
      </div>

      {preview && (
        <>
          <div className="space-y-2">
            <button
              type="button"
              disabled={Boolean(pending)}
              onClick={() => choose("merge")}
              className="focus-ring btn btn-primary min-h-12 w-full"
            >
              {pending === "merge" ? "Merging..." : "Merge"}
            </button>
            <p className="text-xs font-medium leading-5 text-text-2">{preview.mergeText}</p>
          </div>

          {preview.accountEmpty ? (
            <p className="text-xs font-medium leading-5 text-text-3">
              The account is empty, so Merge simply uploads this device&apos;s data.
            </p>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                disabled={Boolean(pending)}
                onClick={() => choose("useAccount")}
                className="focus-ring btn btn-secondary min-h-12 w-full"
              >
                {pending === "useAccount" ? "Applying..." : "Use the account's data on this device"}
              </button>
              <p className="text-xs font-medium leading-5 text-text-2">{preview.useAccountText}</p>
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={Boolean(pending)}
        onClick={() => choose("cancel")}
        className="focus-ring btn btn-ghost min-h-11 w-full"
      >
        Cancel
      </button>
      <p className="-mt-2 text-center text-xs font-medium text-text-3">Cancel signs you out. Nothing on this device changes.</p>
    </div>
  );
}
