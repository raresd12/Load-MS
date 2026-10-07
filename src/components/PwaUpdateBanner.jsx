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
      className="banner-enter sticky top-0 z-40 bg-bg-bar px-3 py-2 min-[390px]:px-4"
    >
      <div className="card-active mx-auto flex w-full max-w-6xl flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-text-1">
          A new version is available. Your data and any workout in progress stay on this device.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReload}
            disabled={isReloading}
            className="btn btn-primary"
          >
            <RefreshCw aria-hidden="true" size={15} className={isReloading ? "animate-spin" : ""} />
            {isReloading ? "Reloading..." : "Reload"}
          </button>
          <button
            type="button"
            onClick={onLater}
            disabled={isReloading}
            className="btn btn-ghost"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
