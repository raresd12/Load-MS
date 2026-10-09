import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  BookOpen,
  CheckSquare,
  ClipboardList,
  Dumbbell,
  History,
  Home,
  MoreHorizontal,
  Settings,
  TriangleAlert,
} from "lucide-react";
import DaySelect from "./components/nav/DaySelect.jsx";
import LazyPageBoundary from "./components/ui/LazyPageBoundary.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import MorePage from "./pages/MorePage.jsx";
import ReadinessPage from "./pages/ReadinessPage.jsx";
import WorkoutLogPage from "./pages/WorkoutLogPage.jsx";
import WorkoutsPage from "./pages/WorkoutsPage.jsx";
import { getProgramDay, workoutProgram } from "./config/workoutProgram.js";
import {
  planSyncRefresh,
  storageEventKeys,
  SYNC_REFRESH_SOURCES,
  workoutDraftsAfterRefresh,
} from "./lib/accountView.js";
import { buildDeloadCardModel } from "./lib/coachControlsView.js";
import {
  DATE_KEY_RESYNC_INTERVAL_MS,
  getDateRolloverAction,
  getLocalDateKey,
} from "./lib/date.js";
import {
  applyProgramDeload,
  dismissDeloadSuggestion,
  endProgramDeload,
  evaluateDeloadNeed,
} from "./lib/deload.js";
import { clearExerciseOverrideChecked, setExerciseOverrideChecked } from "./lib/overrides.js";
import {
  applyProgramDraft,
  deriveProgramStatePatchFromSessions,
  duplicateProgram,
  getActiveProgram,
  getActiveProgramId,
  getExerciseLibrary,
  getProgramDayViewModels,
  getProgramState,
  getPrograms,
  importProgramShare,
  persistWorkoutSave,
  removeExerciseFromNextPlans,
  saveProgramDraft,
  seedDefaultProgramIfNeeded,
  setActiveProgramChecked,
  setProgramArchived,
  updateProgramExerciseProfileChecked,
  updateProgramExerciseTargetChecked,
  updateProgramMetadataChecked,
  updateProgramProfileChecked,
} from "./lib/programStorage.js";
import { openStudioSession, updateStudioSessionDraft } from "./lib/programStudio.js";
import { createLazyPages } from "./lib/lazyPages.js";
import { generateNextPlan, getPlanForDay, interpretWellness } from "./lib/progression.js";
import { saveReadinessCheckIn } from "./lib/readinessSave.js";
import { getBeatLastCue, getDateTime } from "./lib/sessionAnalytics.js";
import { buildResolvedPlan, rebuildSessionFromEdits } from "./lib/sessionEdit.js";
import {
  createDefaultWellness,
  createDraft,
  createDraftFromStorage,
  createNeutralReadiness,
  getPlanExercise,
  normalizeManualWeight,
  normalizeWellness,
  validateDraft,
} from "./lib/sessionNormalize.js";
import {
  SECRET_STORAGE_KEYS,
  STORAGE_KEYS,
  STORAGE_WRITE_REASONS,
  buildSaveErrorMessage,
  buildStorageWarnings,
  clearStorageIssue,
  discardCorruptStorageValue,
  getStorageIssues,
  isLocalStorageEvent,
  readSecret,
  readStorageResult,
  subscribeStorageIssues,
  subscribeStorageWrites,
  useLocalStorageState,
  writeStorage,
} from "./lib/storage.js";
import { draftHasLoggedData, getPlanSlotSignature, resolveWorkoutDraftKey } from "./lib/workoutDraft.js";
import { buildPostWorkoutCoachRecap } from "./lib/workoutRecap.js";
import { buildWorkoutSaveBundle } from "./lib/workoutSave.js";

/**
 * Decision H4-6: the training path (Dashboard, Readiness, Workouts, Workout
 * Log) is in the startup chunk so it renders offline instantly; the heavy
 * administration pages load on demand. A nav hover / focus preload and the
 * React.lazy render share one fetch. Decision H4-8: a failed chunk load is
 * shown inline by LazyPageBoundary and "Try again" renders a NEW lazy
 * component (React.lazy never calls its loader again after a rejection).
 */
const lazyPages = createLazyPages({
  lazy,
  // The retry of a chunk URL the browser remembers as failed (same file, new
  // module-map entry); only URLs of this origin are imported.
  importModule: (url) => import(/* @vite-ignore */ url),
  origin: typeof window !== "undefined" ? window.location.origin : undefined,
  loaders: {
    program: () => import("./pages/ProgramPage.jsx"),
    library: () => import("./pages/LibraryPage.jsx"),
    progress: () => import("./pages/ProgressPage.jsx"),
    history: () => import("./pages/HistoryPage.jsx"),
    settings: () => import("./pages/SettingsPage.jsx"),
  },
});

// Fire-and-forget: a failed prefetch is not an error the user has to see (the
// page itself reports it when it is opened) and never an unhandled rejection.
function preloadTab(tabId) {
  lazyPages.prefetch(tabId);
}

function PageLoadingFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="card text-sm font-semibold text-text-2"
    >
      Loading...
    </div>
  );
}

const tabs = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "readiness", label: "Readiness", icon: Activity },
  { id: "program", label: "Program", icon: ClipboardList },
  { id: "workouts", label: "Workouts", icon: Dumbbell },
  { id: "workout-log", label: "Workout Log", icon: CheckSquare },
  { id: "library", label: "Library", icon: BookOpen },
  { id: "progress", label: "Progress", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

const mobilePrimaryTabs = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "readiness", label: "Readiness", icon: Activity },
  { id: "workouts", label: "Workouts", icon: Dumbbell },
  { id: "workout-log", label: "Log", icon: CheckSquare },
  { id: "more", label: "More", icon: MoreHorizontal },
];

const moreTabs = [
  { id: "program", label: "Program", icon: ClipboardList },
  { id: "library", label: "Library", icon: BookOpen },
  { id: "progress", label: "Progress", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

const secondaryTabIds = new Set(moreTabs.map((tab) => tab.id));

const dayScopedTabs = new Set(["workout-log"]);

function isValidTab(tabId) {
  return tabId === "more" || tabs.some((tab) => tab.id === tabId);
}

function StorageWarningBanner({ warnings, onDismiss, onDiscard, onOpenSettings }) {
  if (!warnings?.length) {
    return null;
  }

  return (
    <div className="mb-4 space-y-2" role="alert">
      {warnings.map((warning) => (
        <div
          key={warning.id}
          className="card border border-warn/40 p-3"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-warn">{warning.title}</p>
              <p className="mt-1 break-words text-xs font-medium leading-5 text-text-2">
                {warning.message}
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenSettings}
              className="focus-ring btn btn-primary btn-sm min-h-11"
            >
              Open Settings
            </button>
            {warning.canDiscard && onDiscard && (
              <button
                type="button"
                onClick={() => onDiscard(warning)}
                className="focus-ring btn btn-secondary btn-sm min-h-11"
              >
                Discard unreadable data
              </button>
            )}
            <button
              type="button"
              onClick={() => onDismiss(warning)}
              className="focus-ring btn btn-secondary btn-sm min-h-11"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [sessions, setSessions, sessionsStorageStatus] = useLocalStorageState(
    STORAGE_KEYS.sessions,
    [],
  );
  const [nextPlans, setNextPlans, nextPlansStorageStatus] = useLocalStorageState(
    STORAGE_KEYS.nextPlans,
    {},
  );
  const [setupCues, setSetupCues] = useLocalStorageState(STORAGE_KEYS.setupCues, {});
  const [readinessByDate, setReadinessByDate] = useLocalStorageState(
    STORAGE_KEYS.readinessByDate,
    {},
  );
  const [workoutDrafts, setWorkoutDrafts, workoutDraftsStorageStatus] = useLocalStorageState(
    STORAGE_KEYS.workoutDrafts,
    {},
  );
  const [appUiState, setAppUiState] = useLocalStorageState(STORAGE_KEYS.appUiState, {});
  const [programRevision, setProgramRevision] = useState(() => {
    seedDefaultProgramIfNeeded();
    return 0;
  });
  const programs = useMemo(() => getPrograms(), [programRevision]);
  const allPrograms = useMemo(() => getPrograms({ includeArchived: true }), [programRevision]);
  const archivedPrograms = useMemo(
    () => allPrograms.filter((program) => Boolean(program.isArchived)),
    [allPrograms],
  );
  const activeProgramId = useMemo(() => getActiveProgramId(), [programRevision]);
  const activeProgram = useMemo(
    () => getActiveProgram() ?? programs.find((program) => !program.isArchived) ?? null,
    [programs, programRevision],
  );
  const activeProgramDays = useMemo(
    () => (activeProgram ? getProgramDayViewModels(activeProgram.id) : workoutProgram.days),
    [activeProgram, programRevision],
  );
  const activeProgramState = useMemo(
    () => (activeProgram ? getProgramState(activeProgram.id) : null),
    [activeProgram, programRevision],
  );
  const exerciseLibrary = useMemo(() => getExerciseLibrary(), [programRevision]);
  const nextRecommendedDay = useMemo(
    () =>
      activeProgramDays.find((day) => day.id === activeProgramState?.nextRecommendedDayId) ??
      null,
    [activeProgramDays, activeProgramState],
  );
  const [selectedDayId, setSelectedDayId] = useState(
    () => appUiState.selectedDayId ?? activeProgramDays[0]?.id ?? workoutProgram.cycleOrder[0],
  );
  const [activeTab, setActiveTab] = useState(
    () => (isValidTab(appUiState.activeTab) ? appUiState.activeTab : "dashboard"),
  );
  const [lastGeneratedPlan, setLastGeneratedPlan] = useState(null);
  // Phase H2: open Program Studio session { draft, mode, review, isResumed } and
  // the outcome line shown on the Program page after a save / apply.
  const [programStudio, setProgramStudio] = useState(null);
  const [programStudioMessage, setProgramStudioMessage] = useState("");
  const [validationErrors, setValidationErrors] = useState([]);
  const [workoutLogTarget, setWorkoutLogTarget] = useState(null);
  const [postWorkoutRecap, setPostWorkoutRecap] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [todayDateKey, setTodayDateKey] = useState(() => getLocalDateKey());
  const [readinessDraft, setReadinessDraft] = useState(() =>
    normalizeWellness(readinessByDate[getLocalDateKey()]?.wellness ?? createDefaultWellness()),
  );
  const [readinessSaveMessage, setReadinessSaveMessage] = useState("");
  const [storageIssues, setStorageIssues] = useState(() => getStorageIssues());
  const [dismissedStorageIssueIds, setDismissedStorageIssueIds] = useState(() => new Set());

  // Midnight rollover (handoff F13, decision H4-2): the local date key follows
  // the clock while the app stays mounted, resynced every
  // DATE_KEY_RESYNC_INTERVAL_MS and on focus / visibilitychange. Readiness
  // follows the new date immediately; the Workout Log keeps working on a draft
  // that already has logged data (see resolveWorkoutDraftKey) so a session
  // that crosses midnight is not replaced by a blank draft mid-workout.
  useEffect(() => {
    function syncTodayDateKey() {
      const currentKey = getLocalDateKey();
      setTodayDateKey((previousKey) => (previousKey === currentKey ? previousKey : currentKey));
    }

    const intervalId = window.setInterval(syncTodayDateKey, DATE_KEY_RESYNC_INTERVAL_MS);
    window.addEventListener("focus", syncTodayDateKey);
    document.addEventListener("visibilitychange", syncTodayDateKey);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncTodayDateKey);
      document.removeEventListener("visibilitychange", syncTodayDateKey);
    };
  }, []);

  const previousDateKeyRef = useRef(todayDateKey);
  useEffect(() => {
    const action = getDateRolloverAction(previousDateKeyRef.current, todayDateKey);

    if (!action.changed) {
      return;
    }

    previousDateKeyRef.current = todayDateKey;

    if (action.resetReadinessDraft) {
      setReadinessDraft(
        normalizeWellness(readinessByDate[todayDateKey]?.wellness ?? createDefaultWellness()),
      );
    }

    if (action.resetReadinessSaveMessage) {
      setReadinessSaveMessage("");
    }

    if (action.resetRecap) {
      setPostWorkoutRecap(null);
    }
    // workoutDrafts are never touched here (action.keepWorkoutDraft):
    // resolveWorkoutDraftKey decides which draft the Workout Log resumes.
  }, [todayDateKey, readinessByDate]);

  // Decision H4-6: the active tab's chunk is requested as soon as the tab is
  // selected (React.lazy does the same on render; this also covers the "more"
  // page and tabs restored from appUiState before their first render).
  useEffect(() => {
    preloadTab(activeTab);
  }, [activeTab]);

  // Decision H4-8: the lazy components are read from the registry on every
  // render, so a page whose chunk failed gets a fresh React.lazy component
  // the next time it is opened or when "Try again" re-renders the shell.
  const [, setLazyPageRetryCount] = useState(0);
  const ProgramPage = lazyPages.getComponent("program");
  const LibraryPage = lazyPages.getComponent("library");
  const ProgressPage = lazyPages.getComponent("progress");
  const HistoryPage = lazyPages.getComponent("history");
  const SettingsPage = lazyPages.getComponent("settings");

  function retryLazyPage(pageId) {
    lazyPages.retry(pageId);
    setLazyPageRetryCount((count) => count + 1);
  }

  useEffect(() => subscribeStorageIssues(setStorageIssues), []);

  const storageWarnings = useMemo(
    () =>
      buildStorageWarnings({
        storageIssues,
        hookStatuses: [
          { key: STORAGE_KEYS.sessions, status: sessionsStorageStatus },
          { key: STORAGE_KEYS.nextPlans, status: nextPlansStorageStatus },
          { key: STORAGE_KEYS.workoutDrafts, status: workoutDraftsStorageStatus },
        ],
      }).filter((warning) => !dismissedStorageIssueIds.has(warning.id)),
    [
      storageIssues,
      sessionsStorageStatus,
      nextPlansStorageStatus,
      workoutDraftsStorageStatus,
      dismissedStorageIssueIds,
    ],
  );

  function dismissStorageWarning(warning) {
    setDismissedStorageIssueIds((current) => new Set([...current, warning.id]));

    if (warning.fromIssue) {
      clearStorageIssue(warning.key, warning.kind);
    }
  }

  /**
   * Decision new-U: the explicit way out of an unreadable key. The raw text
   * stays under its `.corrupt-<n>` copy; the key itself is removed so the
   * defaults the app already shows can be saved again, and the default
   * programs are re-seeded when a program key was discarded.
   */
  function discardCorruptStorage(warning) {
    const confirmed = window.confirm(
      `Discard the unreadable data under "${warning.key}"? A copy stays in browser storage${
        warning.corruptCopyKey ? ` as "${warning.corruptCopyKey}"` : ""
      }, but the app will save its current defaults over this key from now on.`,
    );

    if (!confirmed) {
      return;
    }

    const result = discardCorruptStorageValue(warning.key);

    if (!result.ok) {
      window.alert(result.error);
      return;
    }

    setDismissedStorageIssueIds((current) => new Set([...current, warning.id]));
    seedDefaultProgramIfNeeded();
    refreshProgramData();
  }

  const selectedDay = useMemo(
    () =>
      activeProgramDays.find((day) => day.id === selectedDayId) ??
      activeProgramDays[0] ??
      getProgramDay(selectedDayId),
    [activeProgramDays, selectedDayId],
  );
  // Decision H6-26: while the open day has logged sets, a plan pulled by the
  // sync waits; the day keeps the plan it was started with until the workout
  // is saved or cleared.
  const [syncHeldPlan, setSyncHeldPlan] = useState(null);
  const basePlan = useMemo(
    () =>
      getPlanForDay(
        selectedDay,
        syncHeldPlan && syncHeldPlan.dayId === selectedDayId ? syncHeldPlan.entry : nextPlans[selectedDayId],
      ),
    [selectedDay, nextPlans, selectedDayId, syncHeldPlan],
  );
  // Decision 19.4-2: the plan Workout Log logs against is resolved through the
  // shared prescription resolver (progression > plan > target > baseline), the
  // same one every Workouts card uses, so both views show the same numbers.
  // programRevision is a dependency because progressions/baselines live in storage.
  const activePlan = useMemo(
    () => buildResolvedPlan(activeProgram?.id ?? null, selectedDay, basePlan),
    [activeProgram?.id, selectedDay, basePlan, programRevision],
  );
  // The draft key normally carries today's date. When today's draft is empty
  // and an in-progress draft of this day from an earlier date still has logged
  // data (a workout crossing midnight), that draft is resumed instead.
  const resolvedDraftKey = useMemo(
    () =>
      resolveWorkoutDraftKey({
        workoutDrafts,
        programId: activeProgramId,
        dayId: selectedDayId,
        todayDateKey,
      }),
    [workoutDrafts, activeProgramId, selectedDayId, todayDateKey],
  );
  const draftKey = resolvedDraftKey.key;
  const draftDateKey = resolvedDraftKey.dateKey;
  const [draft, setDraft] = useState(() =>
    createDraftFromStorage(selectedDay, activePlan, sessions, workoutDrafts, draftKey),
  );
  // Set slots per exercise (decision 19.4-2): a target edit can change the set
  // count of one exercise while the day plan keeps its generatedAt.
  const activePlanSlotSignature = useMemo(() => getPlanSlotSignature(activePlan), [activePlan]);
  const readinessDraftSummary = useMemo(
    () => interpretWellness(readinessDraft),
    [readinessDraft],
  );
  const todayReadinessEntry = readinessByDate[todayDateKey] ?? null;
  const todayReadinessSummary = todayReadinessEntry
    ? todayReadinessEntry.readiness ?? interpretWellness(todayReadinessEntry.wellness)
    : createNeutralReadiness();
  // Decision H5-7 / H5-12: the deload observation is evaluated here with an
  // explicit `now` (the engine never reads the clock); it follows the saved
  // sessions, the check-ins, the program state and the local date.
  const deloadEvaluation = useMemo(
    () =>
      activeProgram
        ? evaluateDeloadNeed({
            program: activeProgram,
            days: activeProgramDays,
            sessions,
            readinessByDate,
            now: new Date().toISOString(),
            state: activeProgramState,
          })
        : null,
    [activeProgram, activeProgramDays, sessions, readinessByDate, activeProgramState, todayDateKey],
  );
  const deloadModel = useMemo(
    () => buildDeloadCardModel(deloadEvaluation, activeProgramState?.deload ?? null),
    [deloadEvaluation, activeProgramState],
  );
  const beatLastCues = useMemo(
    () =>
      Object.fromEntries(
        selectedDay.exercises.map((exercise) => [
          exercise.id,
          getBeatLastCue(selectedDay.id, exercise, sessions, getPlanExercise(activePlan, exercise.id)),
        ]),
      ),
    [selectedDay, sessions, activePlan],
  );

  // Decision H6-26: a draft pulled by the sync for the open day replaces an
  // open draft only when that one has no logged sets.
  const [syncDraftRevision, setSyncDraftRevision] = useState(0);

  useEffect(() => {
    setDraft(createDraftFromStorage(selectedDay, activePlan, sessions, workoutDrafts, draftKey));
    setValidationErrors([]);
  }, [selectedDayId, activePlan.generatedAt, activePlanSlotSignature, draftKey, syncDraftRevision]);

  // Private sync (Phase H6, decisions H6-11, H6-24, H6-26). The sync code is
  // loaded only when this device holds a sync token at launch (Settings loads
  // it on demand), so a guest makes no request. What a sync pulls is written
  // to storage with reason "sync"; the state mirrored here is re-read from
  // storage without a page reload, and an open workout keeps its draft.
  useEffect(() => {
    if (!readSecret(SECRET_STORAGE_KEYS.syncToken)) {
      return undefined;
    }

    let active = true;

    import("./components/account/syncController.js")
      .then(({ getSyncController }) => {
        if (active) {
          getSyncController().scheduler.run("launch");
        }
      })
      .catch(() => {
        // Offline with an uncached chunk: the next launch tries again.
      });

    return () => {
      active = false;
    };
  }, []);

  const hasUnsavedDraft = draftHasLoggedData(draft);
  const deferredProgramRefreshRef = useRef(false);
  const applySyncedKeysRef = useRef(null);

  applySyncedKeysRef.current = (keys, source = SYNC_REFRESH_SOURCES.sync) => {
    const plan = planSyncRefresh({ keys, hasUnsavedDraft, source });
    const fresh = (key, fallback) => {
      const result = readStorageResult(key, fallback);
      return result.ok ? result.value : undefined;
    };
    const apply = (key, fallback, setter, transform = (value) => value) => {
      const value = fresh(key, fallback);

      if (value !== undefined) {
        setter(transform(value));
      }
    };

    if (plan.sessions) {
      apply(STORAGE_KEYS.sessions, [], setSessions);
    }

    if (plan.readinessByDate) {
      apply(STORAGE_KEYS.readinessByDate, {}, setReadinessByDate);
    }

    if (plan.setupCues) {
      apply(STORAGE_KEYS.setupCues, {}, setSetupCues);
    }

    if (plan.nextPlans) {
      if (plan.holdPlan) {
        setSyncHeldPlan((current) =>
          current && current.dayId === selectedDayId
            ? current
            : { dayId: selectedDayId, entry: nextPlans[selectedDayId] },
        );
      }

      apply(STORAGE_KEYS.nextPlans, {}, setNextPlans);
    }

    if (plan.workoutDrafts) {
      apply(STORAGE_KEYS.workoutDrafts, {}, setWorkoutDrafts, (stored) =>
        workoutDraftsAfterRefresh(stored, workoutDrafts, draftKey, plan),
      );

      if (!plan.keepDraftEntry) {
        setSyncDraftRevision((revision) => revision + 1);
      }
    }

    if (plan.programData) {
      refreshProgramData();
    }

    if (plan.deferProgramData) {
      deferredProgramRefreshRef.current = true;
    }
  };

  useEffect(
    () =>
      subscribeStorageWrites((event) => {
        if (event.reason === STORAGE_WRITE_REASONS.sync) {
          applySyncedKeysRef.current?.(event.keys);
        }
      }),
    [],
  );

  // Another tab or window of the app wrote storage (a save, or a sync it
  // ran): re-read the mirrored state the same way, so this tab never saves an
  // older copy over it and the sync never sends that as deletes (H6-35).
  useEffect(() => {
    const handleStorage = (event) => {
      if (!isLocalStorageEvent(event)) {
        return;
      }

      const keys = storageEventKeys(event);

      if (keys.length) {
        // Another tab's write is taken as it is, never written back over
        // (decision H6-46).
        applySyncedKeysRef.current?.(keys, SYNC_REFRESH_SOURCES.tab);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // The held plan and the deferred program refresh are released once the
  // open day has no logged sets (saved, cleared) or another day is opened.
  useEffect(() => {
    if (syncHeldPlan && (!hasUnsavedDraft || syncHeldPlan.dayId !== selectedDayId)) {
      setSyncHeldPlan(null);
    }

    if (!hasUnsavedDraft && deferredProgramRefreshRef.current) {
      deferredProgramRefreshRef.current = false;
      refreshProgramData();
    }
  }, [hasUnsavedDraft, syncHeldPlan, selectedDayId]);

  useEffect(() => {
    setAppUiState((currentState) => {
      if (
        currentState.activeTab === activeTab &&
        currentState.selectedDayId === selectedDayId &&
        currentState.activeProgramId === activeProgramId
      ) {
        return currentState;
      }

      return {
        ...currentState,
        activeTab,
        selectedDayId,
        activeProgramId,
        updatedAt: new Date().toISOString(),
      };
    });
  }, [activeTab, activeProgramId, selectedDayId, setAppUiState]);

  useEffect(() => {
    if (activeProgramDays.length && !activeProgramDays.some((day) => day.id === selectedDayId)) {
      setSelectedDayId(activeProgramDays[0].id);
    }
  }, [activeProgramDays, selectedDayId]);

  function updateWellness(metricId, value) {
    setReadinessSaveMessage("");
    setReadinessDraft((currentWellness) => ({
      ...currentWellness,
      [metricId]: value,
    }));
  }

  function saveTodayReadiness() {
    const wellness = normalizeWellness(readinessDraft);
    // H1 follow-up (decision H2-19): success UI only after the durable write
    // succeeded. saveReadinessCheckIn (src/lib/readinessSave.js) writes the
    // value through the checked writer and decides the message; the hook
    // state is mirrored only on success (its own effect re-writes the
    // identical value) and the form keeps the user's values on failure.
    const result = saveReadinessCheckIn({
      readinessByDate,
      dateKey: todayDateKey,
      wellness,
      readiness: interpretWellness(wellness),
      now: new Date().toISOString(),
      write: (value) => writeStorage(STORAGE_KEYS.readinessByDate, value),
    });

    if (result.ok) {
      setReadinessByDate(result.readinessByDate);
    }

    setReadinessSaveMessage(result.message);
  }

  function handleSelectDay(dayId) {
    const nextDay =
      activeProgramDays.find((day) => day.id === dayId) ??
      activeProgramDays[0] ??
      getProgramDay(dayId);
    const nextPlan = getPlanForDay(nextDay, nextPlans[dayId]);
    const nextDraftKey = resolveWorkoutDraftKey({
      workoutDrafts,
      programId: activeProgramId,
      dayId,
      todayDateKey,
    }).key;

    setSelectedDayId(dayId);
    setDraft(createDraftFromStorage(nextDay, nextPlan, sessions, workoutDrafts, nextDraftKey));
    setValidationErrors([]);
    setPostWorkoutRecap(null);
  }

  function persistWorkoutDraft(nextDraft, status = "in_progress") {
    setWorkoutDrafts((currentDrafts) => ({
      ...currentDrafts,
      [draftKey]: {
        schemaVersion: 1,
        key: draftKey,
        status,
        programId: activeProgramId,
        dayId: selectedDayId,
        date: draftDateKey,
        updatedAt: new Date().toISOString(),
        draft: nextDraft,
      },
    }));
  }

  function clearWorkoutDraft() {
    setWorkoutDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      delete nextDrafts[draftKey];
      return nextDrafts;
    });
  }

  function commitDraft(nextDraft) {
    setDraft(nextDraft);
    persistWorkoutDraft(nextDraft);
  }

  function handleOpenWorkoutLog(dayId = selectedDayId, targetProgramExerciseId = null) {
    if (dayId && dayId !== selectedDayId) {
      handleSelectDay(dayId);
    }

    setWorkoutLogTarget(
      targetProgramExerciseId
        ? {
            programExerciseId: targetProgramExerciseId,
            requestedAt: Date.now(),
          }
        : null,
    );
    setActiveTab("workout-log");
  }

  function refreshProgramData() {
    setProgramRevision((currentRevision) => currentRevision + 1);
  }

  function handleSetActiveProgram(programId) {
    // Success UI only after the write succeeded (fix round 2): a refused write
    // leaves the day selection and the program list on the current program.
    const result = setActiveProgramChecked(programId);

    if (!result.ok) {
      return result;
    }

    const nextDays = getProgramDayViewModels(result.programId);
    setSelectedDayId(nextDays[0]?.id ?? workoutProgram.cycleOrder[0]);
    setLastGeneratedPlan(null);
    setValidationErrors([]);
    refreshProgramData();

    return result;
  }

  function handleDuplicateProgram(programId) {
    const result = duplicateProgram(programId);

    if (result?.ok) {
      refreshProgramData();
    }

    return result;
  }

  function handleImportProgramShare(share) {
    const result = importProgramShare(share);

    if (result.ok ?? result.valid) {
      refreshProgramData();
    }

    return result;
  }

  function handleUpdateProgramMetadata(programId, patch) {
    const result = updateProgramMetadataChecked(programId, patch);

    if (result.ok) {
      refreshProgramData();
    }

    return result;
  }

  function handleUpdateProgramExerciseTarget(programId, programExerciseId, patch) {
    const result = updateProgramExerciseTargetChecked(programId, programExerciseId, patch);

    if (result.ok) {
      // Decision 19.4-2: the pending plan entry for this exercise is dropped so
      // the next session starts from the new target (the stored progression was
      // deleted in the same batch by updateProgramExerciseTargetChecked).
      setNextPlans((currentPlans) => removeExerciseFromNextPlans(currentPlans, programExerciseId));
      refreshProgramData();
    }

    return result;
  }

  function handleArchiveProgram(programId, archived) {
    const result = setProgramArchived(programId, archived);

    if (result.ok) {
      refreshProgramData();
    }

    return result;
  }

  // Decisions H5-3 / H5-12: the coach profile of an exercise and the
  // program-level aggression / cycle length. Neither is a prescription change,
  // so the progression and the pending plans are kept; the day view models
  // are re-read only after the checked write succeeded.
  function handleUpdateProgramExerciseProfile(programId, programExerciseId, patch) {
    const result = updateProgramExerciseProfileChecked(programId, programExerciseId, patch);

    if (result.ok) {
      // Decision H5-17: a measurement change is a unit change; the writer
      // removed the earned progression and any override, and the pending
      // plan entry of that exercise (in the old unit) goes with them.
      if (result.measurementChanged && (programId ?? null) === (activeProgramId ?? null)) {
        setNextPlans((currentPlans) => removeExerciseFromNextPlans(currentPlans, programExerciseId));
      }

      refreshProgramData();
    }

    return result;
  }

  function handleUpdateProgramProfile(programId, patch) {
    const result = updateProgramProfileChecked(programId, patch);

    if (result.ok) {
      refreshProgramData();
    }

    return result;
  }

  // Decisions H5-6 / H5-12: hold / manual override records sit on top of the
  // prescription precedence; the resolved plan (activePlan) and every card
  // re-resolve from the re-read day view model after a successful write.
  function handleSetExerciseOverride(record) {
    const result = setExerciseOverrideChecked(record, { now: new Date().toISOString() });

    if (result.ok) {
      setLastGeneratedPlan(null);
      refreshProgramData();
    }

    return result;
  }

  function handleClearExerciseOverride(programExerciseId) {
    const result = clearExerciseOverrideChecked(programExerciseId, activeProgramId);

    if (result.ok) {
      setLastGeneratedPlan(null);
      refreshProgramData();
    }

    return result;
  }

  // Decisions H5-7 / H5-12: the deload card writes ProgramState through the
  // checked writers; the banner appears only after a successful write.
  function handleApplyDeload(sessionCount) {
    if (!activeProgram || !deloadEvaluation?.level) {
      return { ok: false, error: "No deload suggestion is open." };
    }

    const result = applyProgramDeload({
      programId: activeProgram.id,
      level: deloadEvaluation.level,
      sessions: sessionCount,
      now: new Date(),
    });

    if (result.ok) {
      setLastGeneratedPlan(null);
      refreshProgramData();
    }

    return result;
  }

  function handleDismissDeload() {
    if (!activeProgram) {
      return { ok: false, error: "No active program." };
    }

    const result = dismissDeloadSuggestion(activeProgram.id, {
      signals: (deloadEvaluation?.signals ?? []).filter((signal) => signal.met),
      now: new Date(),
    });

    if (result.ok) {
      refreshProgramData();
    }

    return result;
  }

  function handleEndDeload() {
    if (!activeProgram) {
      return { ok: false, error: "No active program." };
    }

    const result = endProgramDeload(activeProgram.id);

    if (result.ok) {
      setLastGeneratedPlan(null);
      refreshProgramData();
    }

    return result;
  }

  // Phase H2: the Program Studio session lives in App state so switching tabs
  // does not lose an open draft. The Studio reports every edit back
  // (handleProgramStudioDraftChange) because the Program page unmounts on a
  // tab switch: on remount the Studio starts from the latest working copy,
  // while `initialDraft` stays the draft the session opened with (dirty /
  // diff baseline). The working copy is also autosaved.
  function handleOpenProgramStudio(session) {
    setProgramStudioMessage("");
    setProgramStudio(openStudioSession(session));
  }

  function handleProgramStudioDraftChange(draft) {
    setProgramStudio((current) => updateStudioSessionDraft(current, draft));
  }

  function handleCloseProgramStudio() {
    setProgramStudio(null);
    refreshProgramData();
  }

  /**
   * Decision H2-1: a draft without sourceProgramId becomes a NEW inactive
   * program (saveProgramDraft); one that edits a custom program is applied to
   * it (applyProgramDraft) and the pending plan entries of removed / changed
   * exercises are dropped so the next session starts from the new targets
   * (19.4-2, same pattern as handleUpdateProgramExerciseTarget).
   */
  function handleSaveProgramStudioDraft(draft) {
    if (draft?.sourceProgramId) {
      const result = applyProgramDraft(draft);

      if (!result.ok) {
        return result;
      }

      const affectedIds = [...result.removedProgramExerciseIds, ...result.changedProgramExerciseIds];

      if (affectedIds.length) {
        setNextPlans((currentPlans) =>
          affectedIds.reduce((plans, programExerciseId) => removeExerciseFromNextPlans(plans, programExerciseId), currentPlans),
        );
      }

      if (result.programId === activeProgramId) {
        setLastGeneratedPlan(null);
      }

      const { added, removed, changed, kept } = result.summary;
      setProgramStudioMessage(
        `Applied changes to "${result.program.name}": ${added} added, ${removed} removed, ${changed} changed, ${kept} kept.${
          changed || removed
            ? " Progression and pending plans were reset for the changed or removed exercises, so the next session starts from the new targets."
            : ""
        }${result.addedLibraryExerciseCount ? ` ${result.addedLibraryExerciseCount} new Library ${result.addedLibraryExerciseCount === 1 ? "entry" : "entries"} added.` : ""}`,
      );
      setProgramStudio(null);
      refreshProgramData();
      return result;
    }

    const result = saveProgramDraft(draft);

    if (!result.ok) {
      return result;
    }

    setProgramStudioMessage(
      `Saved "${result.program.name}" as a new inactive program with ${result.dayCount} ${result.dayCount === 1 ? "day" : "days"} and ${result.exerciseCount} ${result.exerciseCount === 1 ? "exercise" : "exercises"}.${
        result.addedLibraryExerciseCount ? ` ${result.addedLibraryExerciseCount} new Library ${result.addedLibraryExerciseCount === 1 ? "entry" : "entries"} added.` : ""
      } Use "Set Active" on its card when you are ready to train it.`,
    );
    setProgramStudio(null);
    refreshProgramData();
    return result;
  }

  /**
   * Decision new-E: after a session is edited or deleted, the next plan and
   * progression for that program + day are regenerated from the most recent
   * remaining session of the same program + day, or cleared when none is left.
   * Everything is written through persistWorkoutSave (one batch); React state
   * is only updated when the write succeeded.
   */
  function applyHistoryChange(remainingSessions, programId, dayId) {
    const sortedRemaining = [...remainingSessions].sort(
      (left, right) => getDateTime(right.date) - getDateTime(left.date),
    );
    const programDays = programId ? getProgramDayViewModels(programId) : [];
    const day = programDays.find((candidate) => candidate.id === dayId) ?? null;
    const latestSession =
      sortedRemaining.find(
        (candidate) =>
          candidate.dayId === dayId && (candidate.programId ?? null) === (programId ?? null),
      ) ?? null;
    // Next plans are keyed by day id only (handoff 6.3), so only the active
    // program's plan entry is touched; progressions are keyed by program.
    const touchesActivePlan = (programId ?? null) === (activeProgramId ?? null);
    let nextPlansValue = nextPlans;
    let regeneratedPlan = null;

    if (day && latestSession) {
      const otherSessions = sortedRemaining.filter((candidate) => candidate.id !== latestSession.id);
      // H5-47: the stored session's own snapshot says whether it was logged
      // under a deload or a hold; the state active now does not apply to it.
      regeneratedPlan = generateNextPlan(day, latestSession, otherSessions, { regenerated: true });

      if (touchesActivePlan) {
        nextPlansValue = { ...nextPlans, [dayId]: regeneratedPlan };
      }
    } else if (touchesActivePlan && nextPlans[dayId]) {
      nextPlansValue = { ...nextPlans };
      delete nextPlansValue[dayId];
    }

    // No session left for this program + day: its stored progressions are
    // cleared in the same batch as the sessions, so a failed write leaves
    // storage and React state consistent (nothing is committed).
    const clearsDayProgressions = !regeneratedPlan && Boolean(programId && day);
    // The program's last/next day and last workout date follow the most
    // recent remaining session of that program (fix round 2), in the same batch.
    const programStatePatch =
      programId && programDays.length
        ? deriveProgramStatePatchFromSessions(programId, remainingSessions, programDays)
        : undefined;
    const result = persistWorkoutSave({
      sessions: remainingSessions,
      nextPlans: nextPlansValue === nextPlans ? undefined : nextPlansValue,
      programId: regeneratedPlan || clearsDayProgressions || programStatePatch ? programId : null,
      plan: regeneratedPlan ?? undefined,
      programStatePatch,
      deleteProgressionsForDayId: clearsDayProgressions ? dayId : null,
    });

    if (!result.ok) {
      return result;
    }

    setSessions(remainingSessions);

    if (nextPlansValue !== nextPlans) {
      setNextPlans(nextPlansValue);
    }

    setPostWorkoutRecap(null);
    setLastGeneratedPlan(null);
    refreshProgramData();

    return result;
  }

  function handleDeleteSession(sessionId) {
    const session = sessions.find((candidate) => candidate.id === sessionId);

    if (!session) {
      return { ok: false, error: "Session not found." };
    }

    const remainingSessions = sessions.filter((candidate) => candidate.id !== sessionId);
    return applyHistoryChange(remainingSessions, session.programId ?? null, session.dayId ?? null);
  }

  function handleUpdateSession(sessionId, edits) {
    const session = sessions.find((candidate) => candidate.id === sessionId);

    if (!session) {
      return { ok: false, error: "Session not found." };
    }

    const day = session.programId
      ? getProgramDayViewModels(session.programId).find((candidate) => candidate.id === session.dayId)
      : null;

    if (!day) {
      return { ok: false, error: "This session's program or day no longer exists, so it can only be deleted." };
    }

    const rebuilt = rebuildSessionFromEdits(session, day, edits);

    if (!rebuilt.ok) {
      return rebuilt;
    }

    const remainingSessions = sessions.map((candidate) =>
      candidate.id === sessionId ? rebuilt.session : candidate,
    );
    return applyHistoryChange(remainingSessions, session.programId ?? null, session.dayId ?? null);
  }

  function updateSessionField(field, value) {
    setPostWorkoutRecap(null);
    commitDraft({ ...draft, [field]: value });
  }

  function updateRecoveryActivity(activity, checked) {
    setPostWorkoutRecap(null);
    commitDraft({
      ...draft,
      recoveryActivities: {
        ...draft.recoveryActivities,
        [activity]: checked,
      },
    });
  }

  function updateSetEntry(exerciseId, setIndex, values) {
    setPostWorkoutRecap(null);
    commitDraft({
      ...draft,
      exercises: {
        ...draft.exercises,
        [exerciseId]: {
          ...draft.exercises[exerciseId],
          sets: draft.exercises[exerciseId].sets.map((set, index) =>
            index === setIndex ? { ...set, ...values } : set,
          ),
        },
      },
    });
  }

  function toggleExercisePainFlag(exerciseId, flagged) {
    setPostWorkoutRecap(null);
    commitDraft({
      ...draft,
      exercises: {
        ...draft.exercises,
        [exerciseId]: {
          ...draft.exercises[exerciseId],
          painFlag: Boolean(flagged),
        },
      },
    });
  }

  function updateExerciseNotes(exerciseId, notes) {
    commitDraft({
      ...draft,
      exercises: {
        ...draft.exercises,
        [exerciseId]: {
          ...draft.exercises[exerciseId],
          notes,
        },
      },
    });
  }

  function updateSetupCue(exerciseId, cue) {
    setSetupCues((currentCues) => ({
      ...currentCues,
      [exerciseId]: cue,
    }));
  }

  function updatePlanWeight(exerciseId, value) {
    const updatedPlan = getPlanForDay(selectedDay, nextPlans[selectedDayId]);
    const nextWeight = normalizeManualWeight(value);

    setNextPlans((currentPlans) => ({
      ...currentPlans,
      [selectedDay.id]: {
        ...updatedPlan,
        status: updatedPlan.status === "base" ? "manual" : updatedPlan.status,
        exercises: updatedPlan.exercises.map((exercisePlan) =>
          exercisePlan.exerciseId === exerciseId
            ? {
                ...exercisePlan,
                recommendedWeight: nextWeight,
                // Keeps the manual weight usable even when this entry was
                // refilled from the base plan inside a generated day plan.
                manuallyAdjusted: true,
              }
            : exercisePlan,
        ),
      },
    }));
  }

  function saveWorkout(event) {
    event?.preventDefault?.();
    const errors = validateDraft(selectedDay, draft);

    if (errors.length) {
      setValidationErrors(errors);
      return;
    }

    setValidationErrors([]);
    setSaveError(null);
    const {
      session,
      generatedPlan,
      sessions: nextSessions,
      nextPlans: nextPlansValue,
      workoutDrafts: nextWorkoutDrafts,
      persistArgs,
    } = buildWorkoutSaveBundle({
      day: selectedDay,
      draft,
      // activePlan is already the resolved plan of the selected day (19.4-2).
      plan: activePlan,
      sessions,
      nextPlans,
      workoutDrafts,
      draftKey,
      program: activeProgram,
      programDays: activeProgramDays,
      readinessEntry: todayReadinessEntry,
      todayDateKey,
      setupCues,
    });

    // Review finding F2: one checked batch write. Success UI only after it succeeded;
    // on failure the draft stays as it is and no recap is shown.
    const result = persistWorkoutSave(persistArgs);

    if (!result.ok) {
      setSaveError(buildSaveErrorMessage(result));
      return;
    }

    if (activeProgram?.id) {
      refreshProgramData();
    }
    setSessions(nextSessions);
    setNextPlans(nextPlansValue);
    setWorkoutDrafts(nextWorkoutDrafts);
    setLastGeneratedPlan(generatedPlan);
    // H5-10 / H5-12: records, adherence, coach status and comparison lines
    // need the program context (records by program + occurrence).
    setPostWorkoutRecap(
      buildPostWorkoutCoachRecap(session, sessions, selectedDay, generatedPlan, {
        programs: allPrograms,
        programExercises: activeProgramDays.flatMap((day) => day.exercises),
        exerciseLibrary,
        activeProgram,
      }),
    );
    setDraft(createDraft(selectedDay, generatedPlan, nextSessions));
    setActiveTab("workout-log");
  }

  return (
    <div className="app-clip-x min-h-screen">
      <header className="safe-top mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 pb-4 [--safe-top-pad:1rem] min-[390px]:px-4 sm:gap-5 sm:px-6 sm:pb-5 sm:[--safe-top-pad:1.25rem] lg:px-8">
        <div className="flex min-w-0 items-start justify-between gap-3 sm:gap-4">
          <div>
            <p className="label-accent mb-0 min-[430px]:text-sm">
              Athletic Bodybuilding Coach
            </p>
            <h1 className="mt-1 text-[22px] font-semibold leading-tight text-text-1 min-[430px]:text-[26px] sm:text-[30px]">
              Train, log, progress
            </h1>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-block bg-accent-tint text-accent-soft sm:h-11 sm:w-11">
            <Dumbbell aria-hidden="true" size={23} />
          </div>
        </div>

        {dayScopedTabs.has(activeTab) && (
          <DaySelect
            days={activeProgramDays}
            selectedDayId={selectedDayId}
            onSelectDay={handleSelectDay}
          />
        )}
      </header>

      <main className="app-clip-x safe-bottom mx-auto w-full max-w-6xl px-3 [--safe-bottom-pad:11rem] min-[390px]:px-4 sm:px-6 sm:[--safe-bottom-pad:9rem] lg:px-8">
        <StorageWarningBanner
          warnings={storageWarnings}
          onDismiss={dismissStorageWarning}
          onDiscard={discardCorruptStorage}
          onOpenSettings={() => setActiveTab("settings")}
        />

        {/* Decision HV-3: each tab change re-mounts this wrapper, so the page fades in.
            HV-11: the fade is opacity only with fill mode backwards (in .page-enter),
            so the wrapper never has a transform and the fixed rest timer and the
            full-screen source view inside a page stay pinned to the viewport. */}
        <div key={activeTab} className="page-enter">
        {activeTab === "dashboard" && (
          <DashboardPage
            selectedDay={selectedDay}
            activeProgram={activeProgram}
            nextRecommendedDay={nextRecommendedDay}
            nextPlans={nextPlans}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            sessions={sessions}
            activeProgramDays={activeProgramDays}
            deloadModel={deloadModel}
            onApplyDeload={handleApplyDeload}
            onDismissDeload={handleDismissDeload}
            onEndDeload={handleEndDeload}
            onGoToReadiness={() => setActiveTab("readiness")}
            onStartWorkout={(dayId) => {
              handleSelectDay(dayId);
              setActiveTab("workouts");
            }}
            onGoToWorkoutLog={(dayId) => handleOpenWorkoutLog(dayId)}
          />
        )}

        {activeTab === "readiness" && (
          <ReadinessPage
            todayDateKey={todayDateKey}
            savedEntry={todayReadinessEntry}
            wellness={readinessDraft}
            readiness={readinessDraftSummary}
            saveMessage={readinessSaveMessage}
            onSave={saveTodayReadiness}
            onUpdateWellness={updateWellness}
            onBeginEdit={() => {
              if (todayReadinessEntry) {
                setReadinessDraft(normalizeWellness(todayReadinessEntry.wellness));
                setReadinessSaveMessage("");
              }
            }}
          />
        )}

        {activeTab === "workouts" && (
          <WorkoutsPage
            day={selectedDay}
            days={activeProgramDays}
            selectedDayId={selectedDayId}
            activeProgram={activeProgram}
            programState={activeProgramState}
            nextRecommendedDay={nextRecommendedDay}
            plan={basePlan}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            setupCues={setupCues}
            beatLastCues={beatLastCues}
            deloadModel={deloadModel}
            onApplyDeload={handleApplyDeload}
            onDismissDeload={handleDismissDeload}
            onEndDeload={handleEndDeload}
            onSetOverride={handleSetExerciseOverride}
            onClearOverride={handleClearExerciseOverride}
            onSelectDay={handleSelectDay}
            onGoToReadiness={() => setActiveTab("readiness")}
            onOpenWorkoutLog={handleOpenWorkoutLog}
          />
        )}

        {activeTab === "workout-log" && (
          <WorkoutLogPage
            day={selectedDay}
            activeProgram={activeProgram}
            plan={activePlan}
            draft={draft}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            validationErrors={validationErrors}
            saveError={saveError}
            scrollTarget={workoutLogTarget}
            recap={postWorkoutRecap}
            onUpdateRecoveryActivity={updateRecoveryActivity}
            onUpdateSessionField={updateSessionField}
            onSaveSet={updateSetEntry}
            onTogglePainFlag={toggleExercisePainFlag}
            onSetOverride={handleSetExerciseOverride}
            onClearOverride={handleClearExerciseOverride}
            onGoToReadiness={() => setActiveTab("readiness")}
            onGoToWorkouts={() => setActiveTab("workouts")}
            onGoToHistory={() => setActiveTab("history")}
            onDismissRecap={() => setPostWorkoutRecap(null)}
            onScrollTargetHandled={() => setWorkoutLogTarget(null)}
            onSave={saveWorkout}
          />
        )}

        {activeTab === "progress" && (
          <LazyPageBoundary pageLabel="Progress" onRetry={() => retryLazyPage("progress")}>
            <Suspense fallback={<PageLoadingFallback />}>
              <ProgressPage
                sessions={sessions}
                readinessByDate={readinessByDate}
                programs={allPrograms}
                activeProgram={activeProgram}
                activeProgramDays={activeProgramDays}
                exerciseLibrary={exerciseLibrary}
                deloadEvaluation={deloadEvaluation}
              />
            </Suspense>
          </LazyPageBoundary>
        )}

        {activeTab === "program" && (
          <LazyPageBoundary pageLabel="Program" onRetry={() => retryLazyPage("program")}>
            <Suspense fallback={<PageLoadingFallback />}>
              <ProgramPage
                programs={programs}
                archivedPrograms={archivedPrograms}
                activeProgramId={activeProgramId}
                onDuplicateProgram={handleDuplicateProgram}
                onSetActiveProgram={handleSetActiveProgram}
                onArchiveProgram={handleArchiveProgram}
                onUpdateProgramMetadata={handleUpdateProgramMetadata}
                onUpdateProgramExerciseTarget={handleUpdateProgramExerciseTarget}
                onUpdateProgramExerciseProfile={handleUpdateProgramExerciseProfile}
                onUpdateProgramProfile={handleUpdateProgramProfile}
                onImportProgramShare={handleImportProgramShare}
                studio={programStudio}
                studioMessage={programStudioMessage}
                onOpenStudio={handleOpenProgramStudio}
                onCloseStudio={handleCloseProgramStudio}
                onStudioDraftChange={handleProgramStudioDraftChange}
                onSaveStudioDraft={handleSaveProgramStudioDraft}
                onDismissStudioMessage={() => setProgramStudioMessage("")}
              />
            </Suspense>
          </LazyPageBoundary>
        )}

        {activeTab === "library" && (
          <LazyPageBoundary pageLabel="Library" onRetry={() => retryLazyPage("library")}>
            <Suspense fallback={<PageLoadingFallback />}>
              <LibraryPage
                exercises={exerciseLibrary}
                setupCues={setupCues}
                onLibraryChange={refreshProgramData}
              />
            </Suspense>
          </LazyPageBoundary>
        )}

        {activeTab === "history" && (
          <LazyPageBoundary pageLabel="History" onRetry={() => retryLazyPage("history")}>
            <Suspense fallback={<PageLoadingFallback />}>
              <HistoryPage
                sessions={sessions}
                programs={allPrograms}
                activeProgram={activeProgram}
                activeProgramDays={activeProgramDays}
                exerciseLibrary={exerciseLibrary}
                onDeleteSession={handleDeleteSession}
                onUpdateSession={handleUpdateSession}
              />
            </Suspense>
          </LazyPageBoundary>
        )}

        {activeTab === "settings" && (
          <LazyPageBoundary pageLabel="Settings" onRetry={() => retryLazyPage("settings")}>
            <Suspense fallback={<PageLoadingFallback />}>
              <SettingsPage />
            </Suspense>
          </LazyPageBoundary>
        )}

        {activeTab === "more" && (
          <MorePage tabs={moreTabs} onSelectTab={setActiveTab} onPreloadTab={preloadTab} />
        )}
        </div>
      </main>

      <nav
        aria-label="Main navigation"
        data-fixed-bottom-bar="nav"
        className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg-bar px-2 pt-2 [--safe-bottom-pad:0.5rem] sm:px-3 sm:pt-3 sm:[--safe-bottom-pad:0.75rem]"
      >
        <div className="mx-auto grid max-w-md grid-cols-5 gap-1.5 max-[359px]:gap-1 sm:hidden">
          {mobilePrimaryTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive =
              activeTab === tab.id ||
              (tab.id === "more" && secondaryTabIds.has(activeTab));

            return (
              <button
                key={tab.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActiveTab(tab.id)}
                onMouseEnter={() => preloadTab(tab.id)}
                onFocus={() => preloadTab(tab.id)}
                onTouchStart={() => preloadTab(tab.id)}
                className="focus-ring nav-item flex min-h-14 min-w-0 flex-col items-center justify-center px-1 text-[10px] font-semibold max-[359px]:px-0 max-[359px]:tracking-tight min-[390px]:text-[11px]"
              >
                <Icon aria-hidden="true" size={18} />
                <span className="mt-1 max-w-full truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="mx-auto hidden max-w-6xl grid-cols-9 gap-2 sm:grid">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActiveTab(tab.id)}
                onMouseEnter={() => preloadTab(tab.id)}
                onFocus={() => preloadTab(tab.id)}
                onTouchStart={() => preloadTab(tab.id)}
                className="focus-ring nav-item flex min-h-12 min-w-0 flex-col items-center justify-center px-1 text-[10px] font-semibold lg:px-2 lg:text-xs"
              >
                <Icon aria-hidden="true" size={18} />
                <span className="mt-1 max-w-full truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
