import { createSyncApi } from "../../lib/syncApi.js";
import { createDefaultSyncLock, createLocalSyncStorage, createSyncEngine } from "../../lib/syncEngine.js";
import { subscribeStorageWrites } from "../../lib/storage.js";
import { createSyncScheduler } from "./syncScheduler.js";

// ---------------------------------------------------------------------------
// The one sync engine of this tab (decision H6-11, H6-24). Loaded on demand:
// by the App shell only when a sync token exists at launch, and by the
// Settings account card. A guest never loads this module, so a guest makes
// no request. VITE_SYNC_API_URL is read only here, so the API address lands
// in exactly one chunk (scripts/verify-bundle-h6-no-server.mjs).
// ---------------------------------------------------------------------------

let syncControllerInstance = null;

export function getSyncApiBaseUrl() {
  return String(import.meta.env?.VITE_SYNC_API_URL ?? "");
}

export function getSyncController() {
  if (syncControllerInstance) {
    return syncControllerInstance;
  }

  const storage = createLocalSyncStorage();
  const api = createSyncApi({
    baseUrl: getSyncApiBaseUrl(),
    fetch: (...args) => globalThis.fetch(...args),
    getToken: () => storage.readToken(),
  });
  const engine = createSyncEngine({ api, storage, lock: createDefaultSyncLock() });
  const scheduler = createSyncScheduler({
    engine,
    subscribeWrites: subscribeStorageWrites,
    windowLike: typeof window === "undefined" ? null : window,
    documentLike: typeof document === "undefined" ? null : document,
    navigatorLike: typeof navigator === "undefined" ? null : navigator,
  });

  scheduler.start();
  syncControllerInstance = { engine, scheduler, configured: Boolean(getSyncApiBaseUrl()) };
  return syncControllerInstance;
}
