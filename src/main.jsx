import React, { useEffect, useReducer, useRef } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import PwaUpdateBanner from "./components/PwaUpdateBanner.jsx";
import {
  INITIAL_PWA_UPDATE_STATE,
  PWA_UPDATE_EVENTS,
  reducePwaUpdateState,
  requestPwaReload,
  startPwaUpdateChecks,
} from "./lib/pwaUpdate.js";
import "./styles.css";

/**
 * Service-worker registration with an explicit update prompt (vite-plugin-pwa
 * registerType "prompt", decision H2-16): the new worker waits until the user
 * presses Reload, so an open page is never swapped underneath a workout being
 * logged. The banner state, the hourly / visibility update checks and the
 * Reload call live in src/lib/pwaUpdate.js (fixture: verify-pwa-update.mjs).
 * Drafts live in localStorage and are untouched by the update either way.
 */
function PwaRoot() {
  const [state, dispatch] = useReducer(reducePwaUpdateState, INITIAL_PWA_UPDATE_STATE);
  const updateServiceWorkerRef = useRef(null);

  useEffect(() => {
    let checks = null;
    let disposed = false;

    updateServiceWorkerRef.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        dispatch(PWA_UPDATE_EVENTS.needRefresh);
      },
      onRegisteredSW(_swUrl, swRegistration) {
        if (disposed) {
          return;
        }

        checks = startPwaUpdateChecks({ registration: swRegistration ?? null });
      },
    });

    return () => {
      disposed = true;
      checks?.stop();
    };
  }, []);

  function handleReload() {
    dispatch(PWA_UPDATE_EVENTS.reload);
    requestPwaReload({
      updateServiceWorker: updateServiceWorkerRef.current,
      reloadPage: () => window.location.reload(),
    }).then((result) => {
      if (!result.ok) {
        dispatch(PWA_UPDATE_EVENTS.reloadFailed);
      }
    });
  }

  return (
    <>
      {state.needRefresh && (
        <PwaUpdateBanner
          onReload={handleReload}
          onLater={() => dispatch(PWA_UPDATE_EVENTS.later)}
          isReloading={state.isReloading}
        />
      )}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PwaRoot />
  </React.StrictMode>,
);
