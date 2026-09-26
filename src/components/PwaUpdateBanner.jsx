import { RefreshCw } from "lucide-react";

/**
 * "A new version is available" strip rendered above the app when the service
 * worker has a waiting update (vite-plugin-pwa registerType "prompt").
 * Reload activates the waiting worker and reloads the page; Later hides the
 * strip until the next update check. Neither touches localStorage, so an
 * in-progress workout draft (rpe-tracker.workout-drafts.v1) survives either.
 */
export default function PwaUpdateBanner({ onReload, onLater, isReloading = false }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pwa-update-banner"
      className="sticky top-0 z-40 border-b border-lime-300/40 bg-[#1a1f0f] px-3 py-2 min-[390px]:px-4"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-bold text-lime-100">
          A new version is available. Your data and any workout in progress stay on this device.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReload}
            disabled={isReloading}
            className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" size={15} className={isReloading ? "animate-spin" : ""} />
            {isReloading ? "Reloading..." : "Reload"}
          </button>
          <button
            type="button"
            onClick={onLater}
            disabled={isReloading}
            className="focus-ring min-h-10 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800 disabled:opacity-60"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
