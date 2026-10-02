import {
  formatMeasurementRange,
  getMeasurementProfile,
  getMeasurementTargetRange,
  normalizeSetEntry,
} from "./measurement.js";
import { HOLD_REASON, isOverrideActive } from "./overrides.js";

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Equipment-realistic increments (Phase H5, decision H5-4)
//
// Step table by equipment class: barbell / smith / plate-loaded machine /
// cable 2.5, selectorized stack 5, dumbbell 1 under 10 kg, 2 from 10 to under
// 30 kg, 2.5 from 30 kg (per dumbbell), kettlebell 4, additional load 2.5,
// bodyweight none. An explicit incrementKg (profile override or the built-in
// config of a default program) wins; rounding uses the same step so no
// recommendation lands on a load the equipment cannot make.
// ---------------------------------------------------------------------------

export const EQUIPMENT_STEPS_KG = Object.freeze({
  barbell: 2.5,
  smith: 2.5,
  machine: 2.5,
  selectorized: 5,
  cable: 2.5,
  kettlebell: 4,
  additional: 2.5,
});

export const DUMBBELL_STEP_BANDS_KG = Object.freeze([
  { below: 10, step: 1 },
  { below: 30, step: 2 },
  { below: Infinity, step: 2.5 },
]);

export const PROGRESSION_MODES = Object.freeze([
  "double_progression",
  "reps_first",
  "quality_first",
  "core_control",
  "time_first",
  "distance_first",
]);

export const PROGRAM_AGGRESSIONS = Object.freeze(["conservative", "standard"]);
export const PROFILE_PRIORITIES = Object.freeze(["main", "accessory"]);

/**
 * The equipment class the step table keys on, from the free-text equipment
 * of the Library entry or config ("Dumbbells, bench" -> dumbbell,
 * "Smith machine" -> smith, "Cable machine, rope" -> cable, "Pec deck
 * machine" -> machine, "Selectorized stack" -> selectorized).
 */
export function resolveEquipmentClass(exercise = {}) {
  const text = String(exercise?.equipment ?? "").trim().toLowerCase();

  if (!text) {
    return "unknown";
  }

  if (/dumbbell/.test(text)) {
    return "dumbbell";
  }

  if (/kettlebell/.test(text)) {
    return "kettlebell";
  }

  if (/smith/.test(text)) {
    return "smith";
  }

  if (/selectori|stack|pin[- ]loaded/.test(text)) {
    return "selectorized";
  }

  if (/cable|pulley|rope attachment/.test(text)) {
    return "cable";
  }

  if (/barbell|ez bar|ez-bar|trap bar|hex bar/.test(text)) {
    return "barbell";
  }

  if (/machine|pec deck|hack squat|leg press|plate[- ]loaded/.test(text)) {
    return "machine";
  }

  if (/bodyweight|body weight|pull-?up bar|dip station|parallel bars|plyo|box|mat|floor|none/.test(text)) {
    return "bodyweight";
  }

  if (/band/.test(text)) {
    return "band";
  }

  return "unknown";
}

export function getDumbbellStep(weight) {
  if (weight === null || weight === undefined || weight === "") {
    return null;
  }

  const value = Number(weight);

  if (!Number.isFinite(value)) {
    return null;
  }

  return DUMBBELL_STEP_BANDS_KG.find((band) => value < band.below)?.step ?? 2.5;
}

/**
 * The load step of an equipment class at a given weight (dumbbells depend on
 * the weight band). null for bodyweight / band / unknown.
 */
export function getEquipmentStep(equipmentClass, weight = null) {
  if (equipmentClass === "dumbbell") {
    return getDumbbellStep(weight);
  }

  return EQUIPMENT_STEPS_KG[equipmentClass] ?? null;
}

/**
 * Rounds a load to what the equipment can make: dumbbells to the step of the
 * band the value falls in, everything else to `step`. `mode` is "round"
 * (nearest), "floor" or "ceil".
 */
export function roundToEquipment(value, { equipmentClass = "unknown", step = null, mode = "round" } = {}) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const apply = (input, gridStep) =>
    mode === "floor" ? floorTo(input, gridStep) : mode === "ceil" ? ceilTo(input, gridStep) : roundTo(input, gridStep);

  if (equipmentClass === "dumbbell" && !(step > 0)) {
    const bandStep = getDumbbellStep(value) ?? 1;
    const rounded = apply(value, bandStep);
    // Rounding can cross a band boundary (29.6 -> 30); the result is then
    // re-checked against the band it landed in.
    const landingStep = getDumbbellStep(rounded) ?? bandStep;
    return landingStep === bandStep ? rounded : apply(rounded, landingStep);
  }

  return apply(value, step);
}

function average(values) {
  const cleanValues = values.map(Number).filter(Number.isFinite);
  if (!cleanValues.length) {
    return null;
  }

  return cleanValues.reduce((sum, value) => sum + value, 0) / cleanValues.length;
}

function sum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function roundTo(value, step) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (!step || step <= 0) {
    return Number(value.toFixed(1));
  }

  return Number((Math.round(value / step) * step).toFixed(2));
}

function floorTo(value, step) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (!step || step <= 0) {
    return Number(value.toFixed(1));
  }

  return Number((Math.floor(value / step) * step).toFixed(2));
}

function ceilTo(value, step) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (!step || step <= 0) {
    return Number(value.toFixed(1));
  }

  // 1e-9 absorbs float noise so an on-grid value stays where it is.
  return Number((Math.ceil(value / step - 1e-9) * step).toFixed(2));
}

function getNumericWeight(value, exercise) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string" && value.trim().toLowerCase() === "bw") {
    return exercise.loadType === "optionalExternal" ? 0 : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Only set objects are logs. A null / primitive entry inside a stored
// session's sets (hand-edited storage, a restored backup) is skipped instead
// of throwing from every `set.reps` read (handoff 3.5: old sessions stay
// readable wherever their data is sufficient).
function getSetLogs(exerciseLog) {
  return Array.isArray(exerciseLog?.sets)
    ? exerciseLog.sets.filter((set) => set && typeof set === "object")
    : [];
}

// The logged value of a set in the exercise's measurement (decision H5-1):
// reps for a reps exercise, `seconds` for a timed one, `meters` for a
// distance one. A set of a timed / distance exercise that only carries
// `reps` (logged before H5) is read as it was logged.
function getSetValue(set, measurement = "reps") {
  if (measurement === "time" || measurement === "distance") {
    return normalizeSetEntry(set, { measurement }).value ?? NaN;
  }

  return toNumber(set.reps ?? set.actualReps, NaN);
}

function getLoggedReps(setLogs, measurement = "reps") {
  return setLogs.map((set) => getSetValue(set, measurement)).filter(Number.isFinite);
}

// Decision new-A: the working weight is the heaviest logged set (top set).
// Only sets with at least one completed rep count: a failed attempt logged as
// "130 kg x 0" is not a weight the athlete worked with, so it never becomes
// the next prescription or the load the next session is compared against.
function getTopSetWeight(setLogs, exercise, measurement = "reps") {
  const loggedWeights = setLogs
    .filter((set) => {
      const reps = getSetValue(set, measurement);
      return Number.isFinite(reps) && reps >= 1;
    })
    .map((set) => getNumericWeight(set.weight ?? set.actualWeight ?? set.kg, exercise))
    .filter((value) => value !== null);

  return loggedWeights.length ? Math.max(...loggedWeights) : null;
}

function getLoadJump(exercise) {
  return buildExerciseProfile(exercise).loadIncrementKg ?? 0;
}

// The step to add at `currentWeight`: an explicit step (override / config)
// as it is, otherwise the equipment step at that weight (dumbbell bands).
function getIncrementAt(profile, currentWeight) {
  if (profile.fieldSources.incrementKg !== "classified") {
    return profile.loadIncrementKg;
  }

  return getEquipmentStep(profile.equipmentClass, currentWeight) ?? profile.loadIncrementKg;
}

export function roundLoadForProfile(profile, value, mode = "round") {
  const explicitRound = profile.fieldSources.roundToKg !== "classified";

  // A classified dumbbell rounds to the band of the value it lands in, not
  // to the step of the band it started from (29 + 2 = 31 -> 30, not 32).
  return roundToEquipment(value, {
    equipmentClass: explicitRound ? "unknown" : profile.equipmentClass,
    step: explicitRound || profile.equipmentClass !== "dumbbell" ? profile.roundToKg : null,
    mode,
  });
}

function increaseLoad(currentWeight, exercise) {
  const profile = buildExerciseProfile(exercise);

  if (currentWeight === null || !profile.progressionCaps.canIncreaseLoad) {
    return currentWeight;
  }

  const step = getIncrementAt(profile, currentWeight);

  if (!(step > 0)) {
    return currentWeight;
  }

  const rounded = roundLoadForProfile(profile, currentWeight + step, "round");

  // An off-grid current load (13 kg stored before the dumbbell bands of H5-4)
  // plus one step can round to the grid point beyond the next one (13 + 2 =
  // 15 -> 16, a 3 kg jump). One increase is at most one step: the load then
  // lands on the first grid point above the current one (H5 fix round 1).
  if (rounded !== null && rounded - currentWeight > step + 1e-9) {
    const ceiling = roundLoadForProfile(profile, currentWeight, "ceil");
    return ceiling !== null && ceiling > currentWeight ? ceiling : rounded;
  }

  return rounded;
}

function decreaseLoad(currentWeight, exercise, percentage) {
  const profile = buildExerciseProfile(exercise);

  if (currentWeight === null || !profile.progressionCaps.canIncreaseLoad) {
    return currentWeight;
  }

  const adjusted = currentWeight * (1 - percentage / 100);
  return Math.max(0, roundLoadForProfile(profile, adjusted, "floor"));
}

function getExerciseIds(exerciseOrId) {
  if (typeof exerciseOrId === "string") {
    return [exerciseOrId];
  }

  return [
    exerciseOrId.id,
    exerciseOrId.programExerciseId,
    exerciseOrId.legacyExerciseId,
    exerciseOrId.libraryExerciseId,
  ].filter((id, index, ids) => id && ids.indexOf(id) === index);
}

function getExerciseLog(container, exerciseOrId) {
  const ids = getExerciseIds(exerciseOrId);
  const logs = container?.exercises ?? container ?? {};
  const matchedId = ids.find((id) => logs?.[id]);

  if (matchedId) {
    return logs[matchedId];
  }

  if (Array.isArray(logs)) {
    const matchedExercise = logs.find((log) =>
      ids.some((id) =>
        [
          log?.id,
          log?.exerciseId,
          log?.programExerciseId,
          log?.legacyExerciseId,
          log?.libraryExerciseId,
        ].includes(id),
      ),
    );

    if (matchedExercise) {
      return matchedExercise;
    }
  }

  const analyticsSummary = container?.analytics?.exerciseSummaries?.find((summary) =>
    ids.includes(summary.exerciseId) || ids.includes(summary.programExerciseId),
  );

  if (analyticsSummary) {
    return {
      exerciseRPE: analyticsSummary.exerciseRPE,
      totalReps: analyticsSummary.totalReps,
      setCount: analyticsSummary.setCount,
      averageWeight: analyticsSummary.averageWeight,
      sets: [],
    };
  }

  const workoutSets = container?.workoutSets?.filter(
    (set) => ids.includes(set.programExerciseId) || ids.includes(set.exerciseId),
  );

  if (!workoutSets?.length) {
    return null;
  }

  const setRpes = workoutSets
    .map((set) => Number(set.actualRPE ?? set.rpe))
    .filter(Number.isFinite);
  const exerciseRPE = setRpes.length
    ? Number((setRpes.reduce((total, rpe) => total + rpe, 0) / setRpes.length).toFixed(1))
    : null;

  return {
    exerciseRPE,
    sets: workoutSets
      .slice()
      .sort((left, right) => left.setNumber - right.setNumber)
      .map((set) => ({
        reps: set.actualReps ?? set.reps,
        weight: set.actualWeight ?? set.weight ?? set.kg,
        rpe: set.actualRPE ?? set.rpe,
      })),
  };
}

// ---------------------------------------------------------------------------
// Session timing and history recency (decision new-B)
// ---------------------------------------------------------------------------

export const HISTORY_RECENCY_DAYS = 42;
const HISTORY_SAMPLE_LIMIT = 5;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const LEGACY_HISTORY_SKIPPED_WARNING = "Older sessions without exercise ids were skipped.";

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : new Date(value).getTime();

  return Number.isFinite(time) ? time : null;
}

function getSessionTimestamp(session) {
  return (
    toTimestamp(session?.date) ??
    toTimestamp(session?.savedAt) ??
    toTimestamp(session?.completedAt) ??
    toTimestamp(session?.createdAt)
  );
}

function getSessionTime(session) {
  return getSessionTimestamp(session) ?? 0;
}

/**
 * Whole days between a session's own timestamp (date, savedAt, completedAt or
 * createdAt) and `referenceDate` (Date, ISO string or epoch ms). Returns null
 * when either side has no usable timestamp. Negative when the session is
 * dated after the reference.
 */
export function getSessionAgeDays(session, referenceDate = new Date()) {
  const sessionTime = getSessionTimestamp(session);
  const referenceTime = toTimestamp(referenceDate);

  if (sessionTime === null || referenceTime === null) {
    return null;
  }

  return Math.floor((referenceTime - sessionTime) / DAY_IN_MS);
}

// ---------------------------------------------------------------------------
// Strict progression identity (handoff F1, CLAUDE.md hard rule)
//
// Identity is programId + programExerciseId. Known ids that conflict exclude a
// candidate. Library id / key / name matching is a legacy fallback used only
// when the candidate carries no ids at all, and an ambiguous legacy match is
// skipped with a single warning instead of being guessed.
// ---------------------------------------------------------------------------

function uniqueIds(values) {
  return values.filter(
    (value, index, all) =>
      value !== null && value !== undefined && value !== "" && all.indexOf(value) === index,
  );
}

function normalizeIdentityText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getIdentityContext(exercise, currentSession, dayId) {
  const programExerciseId = exercise?.programExerciseId ?? exercise?.id ?? null;
  const libraryIds = uniqueIds([exercise?.libraryExerciseId, exercise?.legacyExerciseId]);

  return {
    programId: exercise?.programId ?? currentSession?.programId ?? null,
    programExerciseId,
    libraryIds,
    // Ids a legacy (id-less) log may be keyed by: the Library/config id or the
    // occurrence id itself.
    legacyIds: uniqueIds([...libraryIds, programExerciseId]),
    name: normalizeIdentityText(exercise?.name),
    dayId: dayId ?? exercise?.dayId ?? currentSession?.dayId ?? null,
    dayName: normalizeIdentityText(currentSession?.dayName),
  };
}

/**
 * Per-day ambiguity info: Library ids and names that occur more than once in
 * the day, so a legacy log keyed by them cannot be attributed to a single
 * program exercise.
 */
function getDayIdentityOptions(day) {
  const libraryCounts = new Map();
  const nameCounts = new Map();

  for (const exercise of day?.exercises ?? []) {
    for (const id of uniqueIds([exercise?.libraryExerciseId, exercise?.legacyExerciseId])) {
      libraryCounts.set(id, (libraryCounts.get(id) ?? 0) + 1);
    }

    const name = normalizeIdentityText(exercise?.name);
    if (name) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
  }

  return {
    ambiguousLibraryIds: new Set([...libraryCounts].filter(([, count]) => count > 1).map(([id]) => id)),
    ambiguousNames: new Set([...nameCounts].filter(([, count]) => count > 1).map(([name]) => name)),
  };
}

function classifyLogCandidate(candidate, context) {
  if (candidate.programExerciseId && context.programExerciseId) {
    return candidate.programExerciseId === context.programExerciseId
      ? { status: "exact" }
      : { status: "conflict" };
  }

  if (candidate.libraryIds.length) {
    const matched = candidate.libraryIds.find((id) => context.legacyIds.includes(id));
    return matched ? { status: "legacy", via: matched, byName: false } : { status: "conflict" };
  }

  if (candidate.key) {
    return context.legacyIds.includes(candidate.key)
      ? { status: "legacy", via: candidate.key, byName: false }
      : { status: "conflict" };
  }

  const name = normalizeIdentityText(candidate.name);
  if (name && context.name && name === context.name) {
    return { status: "legacy", via: name, byName: true };
  }

  return { status: "none" };
}

function isAmbiguousLegacyMatch(match, identity) {
  if (match.byName) {
    return Boolean(identity?.ambiguousNames?.has(match.via));
  }

  return Boolean(identity?.ambiguousLibraryIds?.has(match.via));
}

function pickLogCandidate(candidates, context, identity) {
  const classified = candidates.map((candidate) => ({
    ...candidate,
    match: classifyLogCandidate(candidate, context),
  }));
  const exact = classified.find((candidate) => candidate.match.status === "exact");

  if (exact) {
    return { log: exact.log, status: "exact" };
  }

  const legacy = classified.filter((candidate) => candidate.match.status === "legacy");

  if (!legacy.length) {
    const status = classified.some((candidate) => candidate.match.status === "conflict")
      ? "conflict"
      : "none";
    return { log: null, status };
  }

  if (legacy.length > 1 || legacy.some((candidate) => isAmbiguousLegacyMatch(candidate.match, identity))) {
    return { log: null, status: "ambiguous" };
  }

  return { log: legacy[0].log, status: "legacy" };
}

function describeLogIdentity(log) {
  return {
    programExerciseId: log?.programExerciseId ?? null,
    libraryIds: uniqueIds([log?.exerciseId, log?.libraryExerciseId, log?.legacyExerciseId]),
    name: log?.name ?? log?.exerciseName ?? null,
  };
}

function buildLogFromWorkoutSets(workoutSets) {
  const setRpes = workoutSets
    .map((set) => Number(set.actualRPE ?? set.rpe))
    .filter(Number.isFinite);
  const exerciseRPE = setRpes.length
    ? Number((setRpes.reduce((total, rpe) => total + rpe, 0) / setRpes.length).toFixed(1))
    : null;

  return {
    exerciseRPE,
    painFlag: workoutSets.some((set) => Boolean(set.painFlag)),
    sets: workoutSets
      .slice()
      .sort((left, right) => toNumber(left.setNumber) - toNumber(right.setNumber))
      .map((set) => ({
        reps: set.actualReps ?? set.reps,
        weight: set.actualWeight ?? set.weight ?? set.kg,
        rpe: set.actualRPE ?? set.rpe,
      })),
  };
}

/**
 * Strict replacement for getExerciseLog on the v2 path. Returns
 * { log, status } where status is exact | legacy | ambiguous | conflict | none.
 * Only exact and legacy carry a log.
 */
function resolveExerciseLog(container, exercise, options = {}) {
  if (!container) {
    return { log: null, status: "none" };
  }

  const context = options.context ?? getIdentityContext(exercise, container, options.dayId);
  const identity = options.identity ?? {};
  const logs = container.exercises;
  const logCandidates = [];

  if (Array.isArray(logs)) {
    for (const log of logs) {
      if (log) {
        logCandidates.push({ key: log.id ?? null, log, ...describeLogIdentity(log) });
      }
    }
  } else if (logs && typeof logs === "object") {
    for (const [key, log] of Object.entries(logs)) {
      if (log) {
        logCandidates.push({ key, log, ...describeLogIdentity(log) });
      }
    }
  }

  const fromLogs = pickLogCandidate(logCandidates, context, identity);
  if (fromLogs.status === "exact" || fromLogs.status === "legacy" || fromLogs.status === "ambiguous") {
    return fromLogs;
  }

  const summaryCandidates = (container.analytics?.exerciseSummaries ?? [])
    .filter(Boolean)
    .map((summary) => ({
      key: null,
      programExerciseId: summary.programExerciseId ?? null,
      libraryIds: uniqueIds([summary.exerciseId, summary.libraryExerciseId]),
      name: summary.exerciseName ?? summary.name ?? null,
      log: {
        exerciseRPE: summary.exerciseRPE,
        totalReps: summary.totalReps,
        setCount: summary.setCount,
        averageWeight: summary.averageWeight,
        sets: [],
      },
    }));
  const fromSummaries = pickLogCandidate(summaryCandidates, context, identity);
  if (fromSummaries.status === "exact" || fromSummaries.status === "legacy" || fromSummaries.status === "ambiguous") {
    return fromSummaries;
  }

  const groups = new Map();
  for (const set of Array.isArray(container.workoutSets) ? container.workoutSets : []) {
    if (!set) {
      continue;
    }

    if (set.programId && context.programId && set.programId !== context.programId) {
      continue;
    }

    const groupKey = set.programExerciseId ?? set.exerciseId ?? null;
    if (!groupKey) {
      continue;
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(set);
  }

  const setCandidates = [...groups.values()].map((sets) => ({
    key: null,
    programExerciseId: sets[0].programExerciseId ?? null,
    libraryIds: uniqueIds(sets.map((set) => set.exerciseId)),
    name: sets[0].exerciseName ?? null,
    log: buildLogFromWorkoutSets(sets),
  }));
  const fromSets = pickLogCandidate(setCandidates, context, identity);
  if (fromSets.status === "exact" || fromSets.status === "legacy" || fromSets.status === "ambiguous") {
    return fromSets;
  }

  const hadConflict = [fromLogs, fromSummaries, fromSets].some((result) => result.status === "conflict");
  return { log: null, status: hadConflict ? "conflict" : "none" };
}

function getPlannedExerciseSnapshot(session, exercise) {
  const planned = session?.plannedExercises;
  if (!planned) {
    return null;
  }

  const map = planned.exercises ?? planned;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const id of getExerciseIds(exercise)) {
      if (map[id] && typeof map[id] === "object") {
        return map[id];
      }
    }
  }

  return getExerciseLog(planned, exercise);
}

function hasUsableExerciseLog(log, measurement = "reps") {
  const setLogs = getSetLogs(log);
  const loggedReps = getLoggedReps(setLogs, measurement);

  if (loggedReps.length) {
    return true;
  }

  const aggregateReps = getAggregateTotalReps(log, loggedReps);
  return aggregateReps !== null && aggregateReps > 0;
}

function isDeloadSnapshotSession(session, exercise) {
  return getPlannedExerciseSnapshot(session, exercise)?.deloadSession === true;
}

function isCompatibleHistorySession(session, context) {
  if (session.programId && context.programId && session.programId !== context.programId) {
    return false;
  }

  if (context.dayId && session.dayId) {
    return session.dayId === context.dayId;
  }

  if (context.dayName && session.dayName) {
    return normalizeIdentityText(session.dayName) === context.dayName;
  }

  return true;
}

/**
 * Selects the same-exercise history for `exercise` from `sessions`.
 *
 * - `qualifying`: every compatible session with a usable log, newest first.
 * - `sessions`: the fresh subset (within HISTORY_RECENCY_DAYS of the current
 *   session's own date), capped at HISTORY_SAMPLE_LIMIT. Sessions without a
 *   usable timestamp are treated as fresh but never trigger a long break.
 * - `longBreak`: the most recent qualifying session is older than the window.
 */
function selectExerciseHistory(dayId, exercise, currentSession, sessions = [], identity = {}) {
  const context = getIdentityContext(exercise, currentSession, dayId);
  const referenceTime = getSessionTimestamp(currentSession) ?? Date.now();
  const measurement = getMeasurementProfile(exercise).measurement;
  let skippedAmbiguous = 0;
  const qualifying = [];

  for (const session of sessions ?? []) {
    if (!session || (currentSession?.id && session.id === currentSession.id)) {
      continue;
    }

    if (!isCompatibleHistorySession(session, context)) {
      continue;
    }

    const match = resolveExerciseLog(session, exercise, { context, identity });

    if (match.status === "ambiguous") {
      skippedAmbiguous += 1;
      continue;
    }

    if (!match.log || !hasUsableExerciseLog(match.log, measurement)) {
      continue;
    }

    qualifying.push(session);
  }

  qualifying.sort((left, right) => getSessionTime(right) - getSessionTime(left));

  const aged = qualifying.map((session) => ({
    session,
    ageDays: getSessionAgeDays(session, referenceTime),
  }));
  // Decision H5-46: a session logged under a deload (its own snapshot says
  // `deloadSession: true`) is training that happened, so it still counts for
  // the long-break check, but its lighter loads are no progression evidence:
  // it is never a history sample nor the previous-session comparison.
  const evidence = aged.filter((entry) => !isDeloadSnapshotSession(entry.session, exercise));
  const fresh = evidence
    .filter((entry) => entry.ageDays === null || entry.ageDays <= HISTORY_RECENCY_DAYS)
    .slice(0, HISTORY_SAMPLE_LIMIT)
    .map((entry) => entry.session);
  const mostRecentAgeDays = aged[0]?.ageDays ?? null;
  const longBreak = mostRecentAgeDays !== null && mostRecentAgeDays > HISTORY_RECENCY_DAYS;
  const warnings = skippedAmbiguous ? [LEGACY_HISTORY_SKIPPED_WARNING] : [];

  return {
    context,
    sessions: fresh,
    qualifying,
    mostRecentAgeDays,
    longBreak,
    staleCount: evidence.length - fresh.length,
    skippedDeload: aged.length - evidence.length,
    skippedAmbiguous,
    warnings,
  };
}

export const wellnessMetrics = [
  { id: "soreness", label: "Soreness" },
  { id: "fatigue", label: "Fatigue" },
  { id: "mood", label: "Mood" },
  { id: "stress", label: "Stress" },
  { id: "sleep", label: "Sleep" },
];

export function interpretWellness(wellness = {}) {
  const wellnessInput = wellness && typeof wellness === "object" ? wellness : {};
  const scores = wellnessMetrics.map((metric) => ({
    ...metric,
    value: toNumber(wellnessInput[metric.id], 3),
  }));
  const lowMetrics = scores.filter((score) => score.value <= 2);
  const averageScore = average(scores.map((score) => score.value)) ?? 3;
  const status =
    averageScore >= 4 && lowMetrics.length === 0
      ? "green"
      : averageScore < 3 || lowMetrics.length >= 2
        ? "red"
        : "yellow";

  return {
    status,
    averageScore,
    isPoor: status === "red",
    isGood: status === "green",
    lowMetrics: lowMetrics.map((metric) => metric.label),
  };
}

export function formatRest(restSeconds) {
  if (Array.isArray(restSeconds)) {
    return `${formatRestValue(restSeconds[0])} - ${formatRestValue(restSeconds[1])}`;
  }

  return formatRestValue(restSeconds);
}

function formatRestValue(seconds) {
  const cleanSeconds = toNumber(seconds);
  const minutes = Math.floor(cleanSeconds / 60);
  const remainingSeconds = cleanSeconds % 60;

  if (!minutes) {
    return `${remainingSeconds} sec`;
  }

  if (!remainingSeconds) {
    return `${minutes} min`;
  }

  return `${minutes} min ${remainingSeconds} sec`;
}

export function formatSetsReps(planExercise) {
  return `${planExercise.sets}x ${planExercise.repsLabel}`;
}

export function formatWeight(weight, exercise) {
  if (exercise.loadType === "bodyweight") {
    return "Bodyweight";
  }

  if (weight === null || weight === undefined || weight === "") {
    return exercise.loadType === "optionalExternal" ? "BW / add kg" : "Enter kg";
  }

  if (typeof weight === "string" && weight.trim().toLowerCase() === "bw") {
    return "BW";
  }

  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight)) {
    return "Enter kg";
  }

  const formattedWeight = Number.isInteger(numericWeight)
    ? numericWeight.toString()
    : numericWeight.toFixed(1);
  const suffix =
    exercise.weightMode && exercise.weightMode !== "kg" ? ` ${exercise.weightMode}` : "";

  return `${formattedWeight} kg${suffix}`;
}

export function isWeightEditable(exercise) {
  return exercise.loadType !== "bodyweight";
}

export function getBasePlan(day) {
  return {
    schemaVersion: 2,
    dayId: day.id,
    dayName: day.name,
    dayType: day.type,
    generatedAt: null,
    sourceSessionId: null,
    status: "base",
    lighterSession: false,
    wellnessSummary: interpretWellness(),
    readinessNotes: [],
    exercises: day.exercises.map((exercise) => {
      const profile = buildExerciseProfile(exercise);

      return {
        exerciseId: exercise.id,
        name: exercise.name,
        sets: exercise.sets,
        repsMin: exercise.repsMin,
        repsMax: exercise.repsMax,
        repsLabel: exercise.repsLabel,
        restSeconds: exercise.restSeconds,
        targetRPE: exercise.targetRPE,
        recommendedWeight: exercise.recommendedWeight,
        previousWeight: exercise.recommendedWeight,
        repFocus: null,
        totalReps: null,
        previousTotalReps: null,
        exerciseRPE: null,
        reasons: ["Base program prescription."],
        conservative: false,
        decision: "hold",
        confidence: "low",
        warnings: [],
        historyTrend: "insufficient_history",
        historySampleSize: 0,
        progressionMode: profile.progressionMode,
        exerciseProfile: getSerializableExerciseProfile(profile),
      };
    }),
  };
}

export function getPlanForDay(day, savedPlan) {
  const basePlan = getBasePlan(day);
  if (!savedPlan || savedPlan.dayId !== day.id) {
    return basePlan;
  }

  return {
    ...basePlan,
    ...savedPlan,
    dayType: day.type,
    exercises: day.exercises.map((exercise) => {
      const savedExercisePlan = savedPlan.exercises?.find(
        (entry) => entry.exerciseId === exercise.id,
      );
      const baseExercisePlan = basePlan.exercises.find(
        (entry) => entry.exerciseId === exercise.id,
      );

      return {
        ...baseExercisePlan,
        ...savedExercisePlan,
        name: exercise.name,
        repsMin: savedExercisePlan?.repsMin ?? exercise.repsMin,
        repsMax: savedExercisePlan?.repsMax ?? exercise.repsMax,
        repsLabel: savedExercisePlan?.repsLabel ?? exercise.repsLabel,
        restSeconds: savedExercisePlan?.restSeconds ?? exercise.restSeconds,
      };
    }),
  };
}

// Deload levels and their load factors (decision H5-7). The math that scales a
// prescription lives in deload.js; the plan only records which level applied.
export const DELOAD_FACTORS = Object.freeze({ lighter_week: 0.9, deload: 0.85 });

export function isDeloadActive(deload) {
  return Boolean(
    deload &&
      typeof deload === "object" &&
      DELOAD_FACTORS[deload.level] !== undefined &&
      (deload.remainingSessions === null || deload.remainingSessions === undefined || deload.remainingSessions >= 1),
  );
}

function getPlanContext(day, options = {}) {
  const overrideMap = new Map();
  const overrides = options.overrides;

  if (Array.isArray(overrides)) {
    overrides.forEach((record) => {
      if (record?.programExerciseId) {
        overrideMap.set(record.programExerciseId, record);
      }
    });
  } else if (overrides && typeof overrides === "object") {
    Object.entries(overrides).forEach(([id, record]) => overrideMap.set(id, record));
  }

  const deload = options.deload === undefined ? day?.deload ?? null : options.deload;

  return {
    overrideMap,
    hasOverrideOption: options.overrides !== undefined,
    programProfile: options.programProfile === undefined ? day?.programProfile ?? null : options.programProfile,
    deload: isDeloadActive(deload) ? deload : null,
  };
}

function getExerciseOverrideFor(exercise, context, session) {
  const record = context.hasOverrideOption ? context.overrideMap.get(exercise.id) ?? null : exercise.override ?? null;
  return isOverrideActive(record, getSessionTimestamp(session)) ? record : null;
}

// The freeze state a session was LOGGED under, from its own plannedExercises
// snapshot (H5 fix round 1, decision H5-15): `deloadSession` / `held` /
// `overrideMode` are written there at save time (sessionEdit.js). When the
// deload has ended or the hold has expired and the session is regenerated
// (new-E: an edit, or the delete of a later session), the current state no
// longer says so; the snapshot does, so the session stays no evidence.
function getSnapshotFreeze(exercise, session) {
  const planned = getPlannedExerciseSnapshot(session, exercise);

  if (!planned || typeof planned !== "object") {
    return { deload: null, held: null };
  }

  const deload =
    planned.deloadSession === true
      ? { level: DELOAD_FACTORS[planned.deloadLevel] !== undefined ? planned.deloadLevel : "lighter_week", remainingSessions: null, fromSnapshot: true }
      : null;
  const held =
    planned.held === true || planned.overrideMode === "hold"
      ? { mode: "hold", note: "", remainingSessions: null, fromSnapshot: true }
      : null;

  return { deload, held };
}

// A plan entry that carries no engine evidence: a held exercise (H5-6) or a
// session logged under a deload (H5-7). Values are what the athlete was
// shown (the planned snapshot), the decision is "hold".
function buildFrozenPlanExercise(exercise, session, profile, { held = null, deload = null }) {
  const planned = getPlannedExerciseSnapshot(session, exercise) ?? {};
  const reasons = held
    ? [HOLD_REASON, held.note ? `Note: ${held.note}` : null].filter(Boolean)
    : [
        `Logged during a ${deload.level === "deload" ? "deload" : "lighter week"}, so this session is not used as progression evidence.`,
      ];

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    sets: planned.sets ?? exercise.sets,
    repsMin: planned.repsMin ?? exercise.repsMin,
    repsMax: planned.repsMax ?? exercise.repsMax,
    repsLabel: planned.repsLabel ?? exercise.repsLabel,
    restSeconds: planned.restSeconds ?? exercise.restSeconds,
    targetRPE: planned.targetRPE ?? exercise.targetRPE,
    recommendedWeight: planned.recommendedWeight ?? exercise.recommendedWeight,
    previousWeight: planned.recommendedWeight ?? exercise.recommendedWeight,
    repFocus: held ? "Held at your request." : "Lighter session: keep every rep crisp and leave effort in reserve.",
    totalReps: null,
    previousTotalReps: null,
    exerciseRPE: null,
    reasons,
    conservative: true,
    decision: "hold",
    confidence: "high",
    warnings: [],
    historyTrend: "insufficient_history",
    historySampleSize: 0,
    progressionMode: profile.progressionMode,
    exerciseProfile: getSerializableExerciseProfile(profile),
    ...(held
      ? { held: true, overrideMode: held.mode, overrideRemainingSessions: held.remainingSessions ?? null }
      : { deloadSession: true, deloadLevel: deload.level }),
  };
}

/**
 * generateNextPlan(day, session, previousSessions = [], options = {})
 *
 * options (Phase H5, all optional; the day view model supplies the same
 * information when the option is absent):
 * - overrides: Array<override record> or { [programExerciseId]: record };
 *   a "hold" record freezes that exercise (decision "hold", reason
 *   "Held by you", `held: true`, no progression evidence). Falls back to
 *   `exercise.override` on the day view model.
 * - deload: the ProgramState.deload the session was logged under
 *   ({ level, remainingSessions, ... }) or null; falls back to `day.deload`.
 *   Under an active deload the plan status is "deload", every exercise is a
 *   hold flagged `deloadSession: true` and no evidence is written.
 * - programProfile: { aggression } (falls back to `day.programProfile`).
 * - regenerated: true when the plan is rebuilt from a STORED session (an
 *   edit, or the delete of a later session). The freeze state then comes
 *   from the session's own plannedExercises snapshot only (H5-15, H5-47);
 *   the deload / hold active now is ignored.
 */
export function generateNextPlan(day, session, previousSessions = [], options = {}) {
  const wellnessSummary = session.readiness ?? interpretWellness(session.wellness);
  const sessionRpe = toNumber(session.sessionRpe, 7);
  const highSessionRpe = sessionRpe >= 9;
  const readinessNotes = [];
  const context = getPlanContext(day, options);

  if (day.type === "recovery") {
    return {
      schemaVersion: 2,
      dayId: day.id,
      dayName: day.name,
      dayType: day.type,
      generatedAt: new Date().toISOString(),
      sourceSessionId: session.id,
      status: "generated",
      lighterSession: wellnessSummary.isPoor,
      wellnessSummary,
      readinessNotes: wellnessSummary.missing
        ? ["No readiness check-in was saved, so recovery guidance stayed neutral."]
        : wellnessSummary.isPoor
          ? ["Readiness was low today, so keep recovery work easy and crisp."]
          : ["Recovery day logged. Keep the next recovery slot flexible."],
      exercises: [],
    };
  }

  if (highSessionRpe) {
    readinessNotes.push("Session RPE was 9 or higher, so next-session jumps stay conservative.");
  }

  if (wellnessSummary.missing) {
    readinessNotes.push("No readiness check-in was saved, so recommendations used neutral readiness.");
  } else if (wellnessSummary.isPoor) {
    readinessNotes.push("Readiness was low today, so progression was kept conservative.");
  } else if (wellnessSummary.isGood) {
    readinessNotes.push("Readiness was strong today, so normal progression rules can work fully.");
  }

  const identity = getDayIdentityOptions(day);
  // The session's own snapshot wins over the current state when it says the
  // session was logged under a deload (decision H5-15): an explicit
  // `options.deload` only adds to it, it cannot turn a deload session into
  // evidence.
  const snapshotDeload = day.exercises
    .map((exercise) => getSnapshotFreeze(exercise, session).deload)
    .find(Boolean) ?? null;
  // Decision H5-47: a REGENERATED plan (an edit, or the delete of a later
  // session) is judged by the snapshot alone. The deload or hold active
  // today says nothing about a session that was logged before it.
  const regenerated = options.regenerated === true;
  const sessionDeload = regenerated ? snapshotDeload : context.deload ?? snapshotDeload;

  if (sessionDeload) {
    readinessNotes.push(
      `This session was logged under a ${sessionDeload.level === "deload" ? "deload" : "lighter week"}, so nothing was progressed from it.`,
    );
  }

  const plan = {
    schemaVersion: 2,
    dayId: day.id,
    dayName: day.name,
    dayType: day.type,
    generatedAt: new Date().toISOString(),
    sourceSessionId: session.id,
    status: sessionDeload ? "deload" : "generated",
    lighterSession: wellnessSummary.isPoor,
    wellnessSummary,
    readinessNotes,
    exercises: day.exercises.map((exercise) => {
      const snapshot = getSnapshotFreeze(exercise, session);
      const held = regenerated
        ? snapshot.held
        : getExerciseOverrideFor(exercise, context, session) ?? snapshot.held;
      const exerciseDeload = sessionDeload ?? snapshot.deload;
      const exerciseWithProfile =
        context.programProfile && !exercise.programProfile
          ? { ...exercise, programProfile: context.programProfile }
          : exercise;

      if (exerciseDeload) {
        return buildFrozenPlanExercise(exerciseWithProfile, session, buildExerciseProfile(exerciseWithProfile), {
          deload: exerciseDeload,
        });
      }

      if (held?.mode === "hold") {
        return buildFrozenPlanExercise(exerciseWithProfile, session, buildExerciseProfile(exerciseWithProfile), {
          held,
        });
      }

      return calculateExerciseRecommendationV2(
        exerciseWithProfile,
        session,
        previousSessions,
        wellnessSummary,
        day.id,
        identity,
      );
    }),
  };

  if (sessionDeload) {
    plan.deload = {
      level: sessionDeload.level,
      factor: DELOAD_FACTORS[sessionDeload.level],
      remainingSessions: sessionDeload.remainingSessions ?? null,
    };
  }

  return plan;
}

function textIncludesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function getFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Phase H5 helper: like getFiniteNumber but an explicit null / empty string
// is "no value" (Number(null) is 0), which the H5 paths must not read as 0 kg
// or 0 s.
function getOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return getFiniteNumber(value);
}

function getExerciseRpeFromLog(exerciseLog, setLogs) {
  const directRpe = getFiniteNumber(exerciseLog?.exerciseRPE ?? exerciseLog?.exerciseRpe);

  if (directRpe !== null) {
    return directRpe;
  }

  const setRpes = setLogs
    .map((set) => getFiniteNumber(set.rpe ?? set.actualRPE))
    .filter((value) => value !== null);

  return average(setRpes);
}

function getAggregateTotalReps(exerciseLog, loggedReps) {
  if (loggedReps.length) {
    return sum(loggedReps);
  }

  return getFiniteNumber(
    exerciseLog?.totalReps ??
      exerciseLog?.completedReps ??
      exerciseLog?.repsCompleted ??
      exerciseLog?.actualReps,
  );
}

function getLoggedSetCount(exerciseLog, loggedReps) {
  if (loggedReps.length) {
    return loggedReps.length;
  }

  return getFiniteNumber(
    exerciseLog?.setCount ?? exerciseLog?.loggedSetCount ?? exerciseLog?.completedSetCount,
  );
}

// v2 working weight (decision new-A): top logged set, then any aggregate
// weight field, then the planned weight. BW handling lives in getNumericWeight.
function getExerciseWorkingWeight(exerciseLog, setLogs, plannedWeight, exercise, measurement = "reps") {
  const topSetWeight = getTopSetWeight(setLogs, exercise, measurement);

  if (topSetWeight !== null) {
    return topSetWeight;
  }

  const aggregateWeight = getFiniteNumber(
    exerciseLog?.topWeight ??
      exerciseLog?.maxWeight ??
      exerciseLog?.averageWeight ??
      exerciseLog?.actualWeight,
  );

  if (aggregateWeight !== null) {
    return aggregateWeight;
  }

  return getNumericWeight(plannedWeight, exercise);
}

export function classifyExerciseType(exercise = {}) {
  const text = [
    exercise.id,
    exercise.name,
    exercise.category,
    exercise.progressionType,
    exercise.muscleGroup,
    exercise.equipment,
    exercise.type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const progressionType = String(exercise.progressionType ?? exercise.type ?? "").toLowerCase();
  const priority = String(exercise.priority ?? "").toLowerCase();
  const equipment = String(exercise.equipment ?? "").toLowerCase();
  const athleticPattern = [
    /\bathletic\b/,
    /\bjump\b/,
    /\bjumps\b/,
    /\bclean\b/,
    /\bexplosive\b/,
    /\bpogo\b/,
    /\bplyo/,
    /\bbasketball\b/,
  ];
  const mobilityPattern = [/\bmobility\b/, /\bstretch/];
  const corePattern = [
    /\bcore\b/,
    /\babs?\b/,
    /\bplank\b/,
    /\bcrunch\b/,
    /\bleg raise\b/,
    /\bsit-?up\b/,
    /\bcopenhagen\b/,
  ];
  const isolationPattern = [
    /\bisolation\b/,
    /\bpump\b/,
    /\bcurl\b/,
    /\bextension\b/,
    /\braise\b/,
    /\bfly\b/,
    /\bcalf\b/,
    /\bhamstring curl\b/,
    /\btibialis\b/,
    /\bpec deck\b/,
    /\bskull\b/,
  ];
  const compoundPattern = [
    /\bbench\b/,
    /\bpress\b/,
    /\bpull-?ups?\b/,
    /\bchin-?ups?\b/,
    /\bdips?\b/,
    /\brow\b/,
    /\bpulldown\b/,
    /\bsquat\b/,
    /\bdeadlift\b/,
    /\brdl\b/,
    /\blunge\b/,
    /\bsplit squat\b/,
  ];

  let type = "compound";

  if (progressionType === "mobility" || textIncludesAny(text, mobilityPattern)) {
    type = "mobility";
  } else if (progressionType === "athletic" || textIncludesAny(text, athleticPattern)) {
    type = "athletic";
  } else if (progressionType === "core" || textIncludesAny(text, corePattern)) {
    type = "core";
  } else if (textIncludesAny(text, isolationPattern)) {
    type = "isolation";
  } else if (
    progressionType === "strength" ||
    progressionType === "hypertrophy" ||
    textIncludesAny(text, compoundPattern)
  ) {
    type = "compound";
  } else if (progressionType === "pump") {
    type = "isolation";
  }

  const isHighPriority = priority === "high";
  const isMainCompound = type === "compound" && (isHighPriority || progressionType === "strength");
  const isWeightedBodyweight = exercise.loadType === "optionalExternal";
  const isLoadable = exercise.loadType !== "bodyweight";
  const isLowPriorityAccessory =
    !isMainCompound &&
    priority !== "high" &&
    (type === "isolation" || type === "core");

  return {
    type,
    isMainCompound,
    isAccessory: !isMainCompound && type !== "athletic" && type !== "mobility",
    isLowPriorityAccessory,
    isHighPriority,
    isLoadable,
    isDumbbell: equipment === "dumbbell",
    isWeightedBodyweight,
  };
}

export function determineProgressionMode(exercise, classification = classifyExerciseType(exercise)) {
  return resolveProgressionMode(exercise, classification);
}

function normalizeProfileText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isLateralRaiseStyle(exercise = {}) {
  const text = [exercise.id, exercise.name, exercise.category, exercise.progressionType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\blateral\b/.test(text) && /\braises?\b/.test(text);
}

export function resolveProgressionMode(exercise = {}, classification = classifyExerciseType(exercise)) {
  const loadType = normalizeProfileText(exercise.loadType);
  // Decision H5-2: a timed or distance exercise progresses its duration /
  // distance before anything else, whatever its type.
  const measurement = getMeasurementProfile(exercise).measurement;

  if (measurement === "time") {
    return "time_first";
  }

  if (measurement === "distance") {
    return "distance_first";
  }

  if (classification.type === "athletic" || classification.type === "mobility") {
    return "quality_first";
  }

  if (classification.type === "core") {
    return "core_control";
  }

  if (loadType === "bodyweight") {
    return "reps_first";
  }

  if (classification.type === "isolation") {
    return "reps_first";
  }

  return "double_progression";
}

/**
 * Decision H5-4. The load step of an exercise: an explicit incrementKg
 * (profile override, then the built-in config) wins; otherwise the equipment
 * step table at `referenceWeight` (the exercise's known weight; a dumbbell
 * without one gets the 2 kg band for a compound, 1 kg otherwise). Bodyweight
 * has no step; additional load and weighted bodyweight use 2.5 kg; an
 * unknown equipment keeps the pre-H5 fallback (2.5 compound / 1 other).
 */
export function resolveLoadIncrement(
  exercise = {},
  classification = classifyExerciseType(exercise),
  referenceWeight = getOptionalNumber(exercise.recommendedWeight),
) {
  const overrideIncrement = getOptionalNumber(exercise.profileOverrides?.incrementKg);

  if (overrideIncrement !== null && overrideIncrement > 0) {
    return overrideIncrement;
  }

  const explicitIncrement = getFiniteNumber(exercise.incrementKg);

  if (explicitIncrement !== null && explicitIncrement > 0) {
    return explicitIncrement;
  }

  if (exercise.loadType === "bodyweight") {
    return null;
  }

  if (classification.isWeightedBodyweight || normalizeProfileText(exercise.weightMode) === "additional load") {
    return EQUIPMENT_STEPS_KG.additional;
  }

  const equipmentClass = resolveEquipmentClass(exercise);

  if (equipmentClass === "dumbbell") {
    return getDumbbellStep(referenceWeight) ?? (classification.type === "compound" ? 2 : 1);
  }

  if (equipmentClass === "bodyweight" || equipmentClass === "band") {
    return classification.type === "compound" ? 2.5 : 1;
  }

  const tableStep = getEquipmentStep(equipmentClass);

  if (tableStep !== null) {
    return tableStep;
  }

  if (classification.type === "athletic") {
    return 1;
  }

  return classification.type === "compound" ? 2.5 : 1;
}

export function resolveRpePolicy(exercise = {}, classification = classifyExerciseType(exercise)) {
  const targetRPE = getFiniteNumber(exercise.targetRPE);
  const lateralRaiseStyle = isLateralRaiseStyle(exercise);

  if (classification.type === "athletic") {
    return {
      maxForLoadIncrease: 7.5,
      highRpeThreshold: 8.5,
      targetRPE,
    };
  }

  if (classification.type === "isolation") {
    return {
      maxForLoadIncrease: lateralRaiseStyle ? 8 : 8.5,
      highRpeThreshold: 9,
      targetRPE,
    };
  }

  if (classification.type === "core") {
    return {
      maxForLoadIncrease: 8.5,
      highRpeThreshold: 9,
      targetRPE,
    };
  }

  return {
    maxForLoadIncrease: 8.5,
    highRpeThreshold: 9,
    targetRPE,
  };
}

export function resolveVolumePolicy(exercise = {}, classification = classifyExerciseType(exercise)) {
  const priority = normalizeProfileText(exercise.priority) || "medium";
  const protectVolume =
    priority === "high" ||
    classification.isMainCompound ||
    classification.type === "athletic" ||
    classification.type === "mobility";

  return {
    priority,
    protectVolume,
    canAutoReduceVolume:
      !protectVolume &&
      priority === "low" &&
      (classification.type === "isolation" || classification.type === "core"),
  };
}

export function resolveProgressionCaps(exercise = {}, classification = classifyExerciseType(exercise)) {
  const loadType = normalizeProfileText(exercise.loadType);
  const isBodyweightOnly = loadType === "bodyweight";
  const hasKnownLoadType = Boolean(loadType);
  const hasKnownWeight = getFiniteNumber(exercise.recommendedWeight) !== null;
  const canIncreaseLoad =
    !isBodyweightOnly && classification.isLoadable && (hasKnownLoadType || hasKnownWeight);

  return {
    canIncreaseLoad,
    isBodyweightOnly,
    requiresRepeatTopRange: isLateralRaiseStyle(exercise),
    protectsMainCompoundVolume: classification.isMainCompound || normalizeProfileText(exercise.priority) === "high",
  };
}

/** "time" | "distance" for the modes that move a duration / a distance, else null. */
export function getProgressionModeMeasurement(mode) {
  return mode === "time_first" ? "time" : mode === "distance_first" ? "distance" : null;
}

/**
 * Decision H5-3. The persisted `profileOverrides` of a program exercise,
 * cleaned: only known fields with usable values survive. Everything else is
 * classified. Returns {} when there is nothing.
 */
export function getProfileOverrides(exercise = {}) {
  const source = exercise?.profileOverrides;

  if (!source || typeof source !== "object") {
    return {};
  }

  const overrides = {};
  const incrementKg = getFiniteNumber(source.incrementKg);
  const roundToKg = getFiniteNumber(source.roundToKg);
  const rpeMax = getFiniteNumber(source.rpeMaxForLoadIncrease);

  // Decision H5-52: a time / distance mode on an exercise measured another
  // way is not usable (it would hold a reps lift on a "time target" forever),
  // so the exercise keeps its classified mode.
  const modeMeasurement = getProgressionModeMeasurement(source.progressionMode);

  if (
    PROGRESSION_MODES.includes(source.progressionMode) &&
    (!modeMeasurement || modeMeasurement === getMeasurementProfile(exercise).measurement)
  ) {
    overrides.progressionMode = source.progressionMode;
  }

  if (incrementKg !== null && incrementKg > 0) {
    overrides.incrementKg = incrementKg;
  }

  if (roundToKg !== null && roundToKg > 0) {
    overrides.roundToKg = roundToKg;
  }

  if (rpeMax !== null) {
    overrides.rpeMaxForLoadIncrease = rpeMax;
  }

  if (PROFILE_PRIORITIES.includes(source.priority)) {
    overrides.priority = source.priority;
  }

  if (typeof source.canIncreaseLoad === "boolean") {
    overrides.canIncreaseLoad = source.canIncreaseLoad;
  }

  return overrides;
}

/**
 * Program-level profile (decision H5-3): { aggression: "conservative" |
 * "standard", unit: "kg" }. Read from the exercise (day view models carry
 * the program's profile on every exercise) or from an explicit object.
 */
export function resolveProgramProfile(source = null) {
  const profile = source && typeof source === "object" ? source : null;
  const aggression = PROGRAM_AGGRESSIONS.includes(profile?.aggression) ? profile.aggression : "standard";

  return { aggression, unit: "kg" };
}

export function buildExerciseProfile(exercise = {}) {
  const classification = classifyExerciseType(exercise);
  const overrides = getProfileOverrides(exercise);
  const classifiedMode = resolveProgressionMode(exercise, classification);
  const progressionMode = overrides.progressionMode ?? classifiedMode;
  const loadIncrementKg = resolveLoadIncrement(exercise, classification);
  const explicitRoundTo = getFiniteNumber(exercise.roundToKg);
  const roundToKg = overrides.roundToKg ?? explicitRoundTo ?? loadIncrementKg ?? 1;
  const classifiedRpePolicy = resolveRpePolicy(exercise, classification);
  const rpePolicy =
    overrides.rpeMaxForLoadIncrease !== undefined
      ? { ...classifiedRpePolicy, maxForLoadIncrease: overrides.rpeMaxForLoadIncrease }
      : classifiedRpePolicy;
  const classifiedVolumePolicy = resolveVolumePolicy(exercise, classification);
  const classifiedRole = classification.isMainCompound || classification.isHighPriority ? "main" : "accessory";
  const role = overrides.priority ?? classifiedRole;
  // A "main" override protects the exercise's volume like a high-priority
  // lift; an "accessory" override makes it reducible under the low-priority
  // accessory rule (9.11) when its type allows it.
  const volumePolicy =
    overrides.priority === undefined
      ? classifiedVolumePolicy
      : overrides.priority === "main"
        ? { ...classifiedVolumePolicy, protectVolume: true, canAutoReduceVolume: false }
        : {
            ...classifiedVolumePolicy,
            protectVolume: false,
            canAutoReduceVolume: classification.type === "isolation" || classification.type === "core",
          };
  const classifiedCaps = resolveProgressionCaps(exercise, classification);
  const progressionCaps =
    overrides.canIncreaseLoad === undefined
      ? classifiedCaps
      : { ...classifiedCaps, canIncreaseLoad: overrides.canIncreaseLoad && !classifiedCaps.isBodyweightOnly };
  const equipment = normalizeProfileText(exercise.equipment) || "unknown";
  const loadType = normalizeProfileText(exercise.loadType) || "unknown";
  const measurement = getMeasurementProfile(exercise);
  const programProfile = resolveProgramProfile(exercise.programProfile);
  const explicitIncrement = getFiniteNumber(exercise.incrementKg);
  const fieldSources = {
    progressionMode: overrides.progressionMode !== undefined ? "override" : "classified",
    incrementKg:
      overrides.incrementKg !== undefined
        ? "override"
        : explicitIncrement !== null && explicitIncrement > 0
          ? "config"
          : "classified",
    roundToKg: overrides.roundToKg !== undefined ? "override" : explicitRoundTo !== null ? "config" : "classified",
    rpeMaxForLoadIncrease: overrides.rpeMaxForLoadIncrease !== undefined ? "override" : "classified",
    priority: overrides.priority !== undefined ? "override" : "classified",
    canIncreaseLoad: overrides.canIncreaseLoad !== undefined ? "override" : "classified",
  };

  return {
    type: classification.type,
    progressionMode,
    equipment,
    equipmentClass: resolveEquipmentClass(exercise),
    loadType,
    weightMode: exercise.weightMode ?? "kg",
    priority: volumePolicy.priority,
    role,
    loadIncrementKg,
    roundToKg,
    rpePolicy,
    volumePolicy,
    progressionCaps,
    measurement: measurement.measurement,
    unit: measurement.unit,
    perSide: measurement.perSide,
    aggression: programProfile.aggression,
    fieldSources,
    isMainCompound: classification.isMainCompound,
    isHighPriority: classification.isHighPriority,
    isWeightedBodyweight: classification.isWeightedBodyweight,
    isDumbbell: classification.isDumbbell || resolveEquipmentClass(exercise) === "dumbbell",
    isLateralRaiseStyle: isLateralRaiseStyle(exercise),
  };
}

function getSerializableExerciseProfile(profile) {
  return {
    type: profile.type,
    progressionMode: profile.progressionMode,
    equipment: profile.equipment,
    loadType: profile.loadType,
    weightMode: profile.weightMode,
    priority: profile.priority,
    loadIncrementKg: profile.loadIncrementKg,
    roundToKg: profile.roundToKg,
    maxRpeForLoadIncrease: profile.rpePolicy.maxForLoadIncrease,
    volumePolicy: profile.volumePolicy.protectVolume
      ? "protected"
      : profile.volumePolicy.canAutoReduceVolume
        ? "reducible_low_priority"
        : "normal",
    // Phase H5 additions (decisions H5-1, H5-3, H5-4).
    equipmentClass: profile.equipmentClass,
    role: profile.role,
    measurement: profile.measurement,
    unit: profile.unit,
    perSide: profile.perSide,
    aggression: profile.aggression,
    fieldSources: { ...profile.fieldSources },
  };
}

export function evaluateReadinessModifier(readiness = {}) {
  const summary = readiness?.status ? readiness : interpretWellness(readiness);
  const status = summary.status ?? "yellow";

  return {
    ...summary,
    status,
    isRed: status === "red" || Boolean(summary.isPoor),
    isYellow: status === "yellow",
    isGreen: status === "green" || Boolean(summary.isGood),
    isMissing: Boolean(summary.missing),
    capsAggression: status === "red",
  };
}

export function evaluateSessionFatigue(sessionRpe) {
  const value = getFiniteNumber(sessionRpe);

  return {
    value,
    isMissing: value === null,
    isManageable: value !== null && value <= 7,
    isProductiveHard: value !== null && value >= 8 && value < 9,
    isVeryHigh: value !== null && value >= 9,
    capsAggression: value !== null && value >= 9,
  };
}

export function evaluateExercisePerformance({
  exercise,
  session,
  previousExerciseSession,
  planned = {},
  identity = {},
}) {
  const measurementProfile = getMeasurementProfile(exercise);
  const measurement = measurementProfile.measurement;
  const exerciseLog = resolveExerciseLog(session, exercise, { identity }).log;
  const setLogs = getSetLogs(exerciseLog);
  const loggedReps = getLoggedReps(setLogs, measurement);
  const previousExerciseLog = resolveExerciseLog(previousExerciseSession, exercise, { identity }).log;
  const previousSetLogs = getSetLogs(previousExerciseLog);
  const previousLoggedReps = getLoggedReps(previousSetLogs, measurement);
  const targetSets = toNumber(planned.sets, exercise.sets);
  // Decision H5-2: a timed / distance target that only has a label ("30 s",
  // H3-17) gets its numeric range from the label; reps targets are unchanged.
  const labelRange =
    measurement === "reps"
      ? null
      : getMeasurementTargetRange({
          repsMin: planned.repsMin ?? exercise.repsMin,
          repsMax: planned.repsMax ?? exercise.repsMax,
          repsLabel: planned.repsLabel ?? exercise.repsLabel,
        });
  const baseRepsMin = planned.repsMin ?? exercise.repsMin;
  const baseRepsMax = planned.repsMax ?? exercise.repsMax;
  const repsMin = labelRange && (baseRepsMin === null || baseRepsMin === undefined) ? labelRange.min : baseRepsMin;
  const repsMax = labelRange && (baseRepsMax === null || baseRepsMax === undefined) ? labelRange.max : baseRepsMax;
  const targetRPE = planned.targetRPE ?? exercise.targetRPE;
  const plannedWeight = planned.recommendedWeight ?? exercise.recommendedWeight;
  const previousPlannedWeight =
    getPlannedExerciseSnapshot(previousExerciseSession, exercise)?.recommendedWeight ?? plannedWeight;
  const workingWeight = getExerciseWorkingWeight(exerciseLog, setLogs, plannedWeight, exercise, measurement);
  const previousWorkingWeight = getExerciseWorkingWeight(
    previousExerciseLog,
    previousSetLogs,
    previousPlannedWeight,
    exercise,
    measurement,
  );
  const exerciseRPE = getExerciseRpeFromLog(exerciseLog, setLogs);
  const totalReps = getAggregateTotalReps(exerciseLog, loggedReps);
  const previousTotalReps = getAggregateTotalReps(previousExerciseLog, previousLoggedReps);
  const loggedSetCount = getLoggedSetCount(exerciseLog, loggedReps) ?? 0;
  const hasSetLevelData = loggedReps.length > 0;
  const hasAggregateData = !hasSetLevelData && totalReps !== null;
  const allSetsLogged = targetSets > 0 && loggedSetCount >= targetSets;
  const targetMinTotal =
    repsMin === null || repsMin === undefined ? null : targetSets * Number(repsMin);
  const targetTopTotal =
    repsMax === null || repsMax === undefined ? null : targetSets * Number(repsMax);
  const allAtMin =
    repsMin === null || repsMin === undefined
      ? allSetsLogged
      : hasSetLevelData
        ? allSetsLogged && loggedReps.every((rep) => rep >= repsMin)
        : allSetsLogged && totalReps !== null && targetMinTotal !== null && totalReps >= targetMinTotal;
  const allAtTop =
    repsMax === null || repsMax === undefined
      ? false
      : hasSetLevelData
        ? allSetsLogged && loggedReps.every((rep) => rep >= repsMax)
        : allSetsLogged && totalReps !== null && targetTopTotal !== null && totalReps >= targetTopTotal;
  const belowMin =
    repsMin === null || repsMin === undefined
      ? false
      : hasSetLevelData
        ? loggedReps.some((rep) => rep < repsMin)
        : totalReps !== null && targetMinTotal !== null && totalReps < targetMinTotal;
  const missedSets = Math.max(0, targetSets - loggedSetCount);
  const belowMinCount =
    repsMin === null || repsMin === undefined
      ? 0
      : hasSetLevelData
        ? loggedReps.filter((rep) => rep < repsMin).length
        : belowMin
          ? 1
          : 0;
  const comparableLoad =
    workingWeight === null ||
    previousWorkingWeight === null ||
    Math.abs(workingWeight - previousWorkingWeight) <= getLoadJump(exercise);
  const regressed =
    totalReps !== null &&
    previousTotalReps !== null &&
    totalReps < previousTotalReps &&
    comparableLoad;
  // Decision new-C: an exercise with no set that has numeric reps (and no
  // positive aggregate rep count) is not evidence. Untouched exercises are
  // saved as sets of nulls, and a planned weight alone must not count.
  const hasMeaningfulData =
    Boolean(exerciseLog) && (hasSetLevelData || (hasAggregateData && totalReps > 0));
  const dataQuality = hasSetLevelData ? "set_level" : hasAggregateData ? "aggregate" : "missing";
  const warnings = [];

  if (hasAggregateData) {
    warnings.push("Set-level data was unavailable, so progression used aggregate reps.");
  }

  // An exercise that was not logged at all is "insufficient_data" (new-C) and
  // says so in its reason; the RPE warning is for a LOGGED exercise whose
  // sets carry no RPE (H5 fix round 1: a skipped lift used to warn that its
  // RPE was unavailable although nothing of it was logged).
  if (exerciseRPE === null && hasMeaningfulData) {
    warnings.push("Exercise RPE was unavailable, so load progression stayed conservative.");
  }

  return {
    exerciseLog,
    planned,
    targetSets,
    repsMin,
    repsMax,
    repsLabel: planned.repsLabel ?? exercise.repsLabel,
    targetRPE,
    plannedWeight,
    previousWeight: plannedWeight,
    workingWeight,
    previousWorkingWeight,
    exerciseRPE,
    hasExerciseRpe: exerciseRPE !== null,
    totalReps,
    previousTotalReps,
    totalRepsImproved:
      totalReps !== null && previousTotalReps !== null && totalReps > previousTotalReps,
    loggedSetCount,
    allSetsLogged,
    allAtMin,
    allAtTop,
    belowMin,
    belowMinCount,
    missedSets,
    regressed,
    hasMeaningfulData,
    dataQuality,
    painFlagged: Boolean(exerciseLog?.painFlag),
    measurement,
    unit: measurementProfile.unit,
    perSide: measurementProfile.perSide,
    warnings,
  };
}

function getSessionReadinessSummary(session) {
  if (session?.readiness?.status) {
    return session.readiness;
  }

  if (session?.readinessSnapshot?.readiness?.status) {
    return session.readinessSnapshot.readiness;
  }

  if (session?.wellness) {
    return interpretWellness(session.wellness);
  }

  return { ...interpretWellness(), missing: true };
}

function isStrongHistoryPerformance(sample) {
  return (
    sample.performance.allAtTop &&
    sample.performance.hasExerciseRpe &&
    sample.performance.exerciseRPE <= 8.5 &&
    !sample.sessionFatigue.isVeryHigh
  );
}

function isGoodHistoryPerformance(sample) {
  return (
    sample.performance.allAtMin &&
    (!sample.performance.hasExerciseRpe || sample.performance.exerciseRPE <= 8.5) &&
    !sample.sessionFatigue.isVeryHigh
  );
}

function isMissedHighRpePerformance(sample) {
  return sample.performance.belowMin && isHighExerciseRpe(sample.performance);
}

function compareHistorySamples(newer, older, exercise) {
  const newerWeight = newer.performance.workingWeight;
  const olderWeight = older.performance.workingWeight;
  const comparableLoad =
    newerWeight === null ||
    olderWeight === null ||
    Math.abs(newerWeight - olderWeight) <= getLoadJump(exercise);
  const newerTotal = newer.performance.totalReps;
  const olderTotal = older.performance.totalReps;

  if (newerTotal === null || olderTotal === null || !comparableLoad) {
    return "unknown";
  }

  if (newerTotal > olderTotal) {
    return "improved";
  }

  if (newerTotal < olderTotal) {
    return "regressed";
  }

  return "stable";
}

export function evaluateExerciseHistory({
  exercise,
  dayId,
  session,
  previousSessions = [],
  planned = {},
  identity = {},
}) {
  const selection = selectExerciseHistory(dayId, exercise, session, previousSessions, identity);
  const samples = selection.sessions
    .map((historySession) => {
      const readinessModifier = evaluateReadinessModifier(getSessionReadinessSummary(historySession));
      const sessionFatigue = evaluateSessionFatigue(historySession.sessionRpe);
      // F11: judge each sample against its own planned snapshot when the
      // session carries one; fall back to the current plan otherwise.
      const samplePlanned = getPlannedExerciseSnapshot(historySession, exercise) ?? planned;
      const performance = evaluateExercisePerformance({
        exercise,
        session: historySession,
        previousExerciseSession: null,
        planned: samplePlanned,
        identity,
      });

      return {
        session: historySession,
        performance,
        readinessModifier,
        sessionFatigue,
        isStrong: false,
        isGood: false,
        isMissedHighRpe: false,
      };
    })
    .filter((sample) => sample.performance.hasMeaningfulData)
    .slice(0, HISTORY_SAMPLE_LIMIT)
    .map((sample) => ({
      ...sample,
      isStrong: isStrongHistoryPerformance(sample),
      isGood: isGoodHistoryPerformance(sample),
      isMissedHighRpe: isMissedHighRpePerformance(sample),
    }));

  const comparisons = samples
    .slice(0, -1)
    .map((sample, index) => compareHistorySamples(sample, samples[index + 1], exercise));
  const strongCount = samples.filter((sample) => sample.isStrong).length;
  const goodCount = samples.filter((sample) => sample.isGood).length;
  const missedHighRpeCount = samples.filter((sample) => sample.isMissedHighRpe).length;
  const highExerciseRpeCount = samples.filter((sample) => isHighExerciseRpe(sample.performance)).length;
  const highSessionRpeCount = samples.filter((sample) => sample.sessionFatigue.isVeryHigh).length;
  const redReadinessCount = samples.filter((sample) => sample.readinessModifier.isRed).length;
  const improvingPairs = comparisons.filter((comparison) => comparison === "improved").length;
  const regressingPairs = comparisons.filter((comparison) => comparison === "regressed").length;
  const consecutiveStrongSessions = samples.findIndex((sample) => !sample.isStrong);
  const consecutiveMissedHighRpe = samples.findIndex((sample) => !sample.isMissedHighRpe);
  const warnings = [...selection.warnings];
  let trend = "insufficient_history";

  if (samples.length >= 2) {
    if (missedHighRpeCount >= 2 || regressingPairs >= 2) {
      trend = "regressing";
    } else if (highExerciseRpeCount >= 2 || highSessionRpeCount >= 2) {
      trend = "repeated_high_rpe";
    } else if (improvingPairs >= 2 || strongCount >= 2) {
      trend = "improving";
    } else {
      trend = "stable";
    }
  }

  if (missedHighRpeCount >= 2) {
    warnings.push("Repeated missed targets with high RPE showed up in recent history.");
  }

  if (highSessionRpeCount >= 2) {
    warnings.push("Recent sessions repeatedly hit session RPE 9+, so progression stays conservative.");
  }

  if (highExerciseRpeCount >= 2) {
    warnings.push("Recent exercise RPE has repeatedly been high.");
  }

  if (redReadinessCount >= 2) {
    warnings.push("Recent readiness was repeatedly low, so history is interpreted conservatively.");
  }

  return {
    trend,
    sampleSize: samples.length,
    samples,
    strongCount,
    goodCount,
    missedHighRpeCount,
    highExerciseRpeCount,
    highSessionRpeCount,
    redReadinessCount,
    improvingPairs,
    regressingPairs,
    consecutiveStrongSessions:
      consecutiveStrongSessions === -1 ? samples.length : consecutiveStrongSessions,
    consecutiveMissedHighRpe:
      consecutiveMissedHighRpe === -1 ? samples.length : consecutiveMissedHighRpe,
    longBreak: selection.longBreak,
    mostRecentSessionAgeDays: selection.mostRecentAgeDays,
    staleSampleCount: selection.staleCount,
    skippedAmbiguousSessions: selection.skippedAmbiguous,
    warnings,
  };
}

function getBaseCoachRecommendation(performance) {
  return {
    decision: "hold",
    confidence: "medium",
    nextWeight: performance.workingWeight,
    nextSets: performance.targetSets,
    repFocus: null,
    conservative: false,
    reasons: [],
    warnings: [...performance.warnings],
    historyTrend: "insufficient_history",
    historySampleSize: 0,
    decisionOverridden: false,
    contextReason: null,
  };
}

function isManageableExerciseRpe(performance, maxRpe = 8.5) {
  return performance.hasExerciseRpe && performance.exerciseRPE <= maxRpe;
}

function isHighExerciseRpe(performance, minRpe = 9) {
  return performance.hasExerciseRpe && performance.exerciseRPE >= minRpe;
}

function canIncreaseLoadNow({
  exercise,
  performance,
  readinessModifier,
  sessionFatigue,
  profile = buildExerciseProfile(exercise),
  maxRpe = profile.rpePolicy.maxForLoadIncrease,
}) {
  return (
    profile.progressionCaps.canIncreaseLoad &&
    performance.workingWeight !== null &&
    performance.allAtTop &&
    isManageableExerciseRpe(performance, maxRpe) &&
    !readinessModifier.isRed &&
    !sessionFatigue.isVeryHigh
  );
}

function getConfidence({ performance, decision, mode }) {
  if (decision === "insufficient_data") {
    return "low";
  }

  if (performance.dataQuality === "set_level" && performance.hasExerciseRpe) {
    return mode === "quality_first" ? "medium" : "high";
  }

  if (performance.dataQuality === "aggregate") {
    return "medium";
  }

  return "low";
}

// ---------------------------------------------------------------------------
// Time / distance progression (decision H5-2): the duration or distance
// grows by a step table before any load change. Time: +5 s under 60 s,
// +10 s from 60 s, never past 600 s per set. Distance: +10 % rounded to 25 m,
// at least 25 m, never past 10,000 m per set.
// ---------------------------------------------------------------------------

export const MEASUREMENT_PROGRESSION = Object.freeze({
  time: Object.freeze({ stepUnder60: 5, stepFrom60: 10, threshold: 60, max: 600 }),
  distance: Object.freeze({ percent: 10, roundTo: 25, minStep: 25, max: 10000 }),
});

export function getMeasurementStep(measurement, value) {
  const current = getOptionalNumber(value);

  if (current === null) {
    return null;
  }

  if (measurement === "time") {
    const rule = MEASUREMENT_PROGRESSION.time;
    return current < rule.threshold ? rule.stepUnder60 : rule.stepFrom60;
  }

  if (measurement === "distance") {
    const rule = MEASUREMENT_PROGRESSION.distance;
    return Math.max(rule.minStep, roundTo((current * rule.percent) / 100, rule.roundTo));
  }

  return null;
}

/**
 * The next target range after one measurement step, or null when the range
 * has no top value or already sits at the cap. Both ends move by the same
 * amount so a "45-60 s" target becomes "55-70 s".
 */
export function increaseMeasurementRange(measurement, min, max) {
  const top = getOptionalNumber(max);

  if (top === null) {
    return null;
  }

  const cap = MEASUREMENT_PROGRESSION[measurement]?.max;
  const step = getMeasurementStep(measurement, top);

  if (!step || cap === undefined) {
    return null;
  }

  const nextMax = Math.min(cap, top + step);

  if (nextMax <= top) {
    return null;
  }

  const low = getOptionalNumber(min);

  return { min: low === null ? null : low + (nextMax - top), max: nextMax, step: nextMax - top };
}

function isMeasurementMode(mode) {
  return mode === "time_first" || mode === "distance_first";
}

export function generateCoachReason(decision, { mode, performance, readinessModifier, sessionFatigue }) {
  if (isMeasurementMode(mode)) {
    const what = mode === "time_first" ? "time" : "distance";

    if (decision === "increase_time" || decision === "increase_distance") {
      return `Every set reached the top of the ${what} target with effort in reserve - the ${what} goes up before any load does.`;
    }

    if (decision === "hold" && readinessModifier.isRed && performance.belowMin) {
      return `You came in under the ${what} target, but recovery was low today - so the call is to repeat it, not cut it.`;
    }

    if (decision === "hold" && sessionFatigue.isVeryHigh) {
      return `That session cost a lot, so the ${what} target stays where it is for now.`;
    }

    if (decision === "hold") {
      return `The ${what} target stays put until every set reaches it with effort inside the target range.`;
    }
  }

  if (readinessModifier.isRed && decision === "hold" && performance.belowMin) {
    return "You came in under target, but recovery was low today - so the call is to repeat this load, not cut it.";
  }

  if (readinessModifier.isRed && decision === "hold" && performance.allAtTop) {
    return "Strong work on a rough day. The load stays put so you can cash that in when you're fresher.";
  }

  if (sessionFatigue.isVeryHigh && decision === "hold") {
    return "That session cost a lot, so the load stays where it is for now.";
  }

  switch (decision) {
    case "increase_load":
      if (mode === "reps_first") {
        return "Every set hit the top of the range with effort to spare - time for more weight.";
      }
      if (mode === "quality_first") {
        return "Execution looked crisp and effort stayed in check, so the load creeps up a touch.";
      }
      if (mode === "core_control") {
        return "Control held all the way to the top of the range, so the difficulty nudges up.";
      }
      return "All sets reached the top of the rep range with effort in reserve - the weight goes up.";
    case "increase_reps":
      return "Same weight next time. The goal is to beat your total reps before adding load.";
    case "reduce_load":
      return "Reps dropped under target at high effort, so the load comes down a touch to rebuild momentum.";
    case "reduce_volume":
      return "Recovery was low and the session ran hot, so one accessory set comes off to protect quality.";
    case "recovery_suggestion":
      return "Recovery signals are low - keep the next one easy.";
    case "deload_suggestion":
      return "Fatigue has been stacking up. A lighter session will do more for you than forcing progress.";
    case "insufficient_data":
      return "Not enough logged data to make a call yet. Log the next session and the coach takes it from there.";
    case "hold":
    default:
      if (mode === "quality_first") {
        return "Holding steady - speed and crisp execution stay the priority over more load.";
      }
      if (mode === "core_control") {
        return "Holding here. Earn the next step with stricter control before adding load or volume.";
      }
      return "The load stays put while you build reps and keep effort inside the target range.";
  }
}

function addUniqueReason(recommendation, reason, position = "end") {
  if (!reason || recommendation.reasons.includes(reason)) {
    return;
  }

  if (position === "start") {
    recommendation.reasons.unshift(reason);
  } else {
    recommendation.reasons.push(reason);
  }
}

function capConfidence(confidence, ceiling) {
  const order = ["low", "medium", "high"];
  const current = order.indexOf(confidence);
  const limit = order.indexOf(ceiling);

  if (current === -1 || limit === -1) {
    return confidence;
  }

  return current > limit ? ceiling : confidence;
}

/**
 * Changes the decision and records that it changed. When a decision changes,
 * the reasons list is rebuilt at the end from the final decision's primary
 * reason plus this single context sentence, so a stale reason for the old
 * decision never survives next to the new one.
 */
function overrideDecision(recommendation, {
  decision,
  nextWeight,
  nextSets,
  repFocus,
  confidence,
  conservative = true,
  contextReason,
}) {
  recommendation.decision = decision;

  if (nextWeight !== undefined) {
    recommendation.nextWeight = nextWeight;
  }

  if (nextSets !== undefined) {
    recommendation.nextSets = nextSets;
  }

  if (repFocus) {
    recommendation.repFocus = repFocus;
  }

  if (confidence) {
    recommendation.confidence = confidence;
  }

  recommendation.conservative = conservative;
  recommendation.decisionOverridden = true;

  if (contextReason) {
    recommendation.contextReason = contextReason;
  }

  return recommendation;
}

function describeBreakLength(days) {
  if (!Number.isFinite(days)) {
    return "more than six weeks";
  }

  const weeks = Math.floor(days / 7);
  return weeks >= 2 ? `${days} days (about ${weeks} weeks)` : `${days} days`;
}

function applyHistoryContext({
  classification,
  mode,
  performance,
  recommendation,
  historySummary,
  sessionFatigue,
  profile,
}) {
  recommendation.historyTrend = historySummary.trend;
  recommendation.historySampleSize = historySummary.sampleSize;
  recommendation.warnings.push(...historySummary.warnings);

  // Decision new-B: the last logged session is older than the recency window.
  if (historySummary.longBreak) {
    return overrideDecision(recommendation, {
      decision: "hold",
      nextWeight: performance.workingWeight,
      nextSets: performance.targetSets,
      repFocus: "Re-establish clean reps at this load before progressing.",
      confidence: capConfidence(recommendation.confidence, "medium"),
      conservative: true,
      contextReason: `Last logged ${describeBreakLength(historySummary.mostRecentSessionAgeDays)} ago - after a long break the load holds until the pattern is re-established.`,
    });
  }

  if (!historySummary.sampleSize) {
    if (recommendation.decision === "increase_load") {
      if (profile.progressionCaps.requiresRepeatTopRange) {
        return overrideDecision(recommendation, {
          decision: "increase_reps",
          nextWeight: performance.workingWeight,
          repFocus: "Repeat top-range reps before adding load.",
          confidence: "medium",
          conservative: true,
          contextReason:
            "This exercise profile uses especially conservative load jumps, so top-range reps must repeat before adding load.",
        });
      }

      recommendation.confidence = "medium";
      recommendation.conservative = true;
      addUniqueReason(
        recommendation,
        "This was the first strong logged pattern for this exercise, so the progression stays small and conservative.",
      );
    }

    // Decision new-D / F3: with no usable history a bad session holds; a
    // reduction needs two consecutive qualifying bad sessions.
    if (recommendation.decision === "reduce_load") {
      return overrideDecision(recommendation, {
        decision: "hold",
        nextWeight: performance.workingWeight,
        repFocus: "Repeat the load once before reducing unless the same issue repeats.",
        confidence: "medium",
        conservative: true,
        contextReason: "One difficult session usually earns a hold, not an automatic reduction.",
      });
    }

    return recommendation;
  }

  const currentMissedHighRpe = performance.belowMin && isHighExerciseRpe(performance);
  // Decision new-D: consecutive means the most recent fresh sample was also a
  // missed-target/high-RPE session.
  const repeatedMissedHighRpe =
    currentMissedHighRpe && historySummary.consecutiveMissedHighRpe >= 1;
  const repeatedHighSessionRpe =
    historySummary.highSessionRpeCount >= 2 ||
    (sessionFatigue.isVeryHigh && historySummary.highSessionRpeCount >= 1);
  const repeatedHighExerciseRpe =
    historySummary.highExerciseRpeCount >= 2 ||
    (isHighExerciseRpe(performance) && historySummary.highExerciseRpeCount >= 1);
  const twoStrongSessions =
    performance.allAtTop &&
    isManageableExerciseRpe(performance) &&
    historySummary.consecutiveStrongSessions >= 1;

  if (historySummary.trend === "improving") {
    addUniqueReason(
      recommendation,
      "Recent history is improving, so this recommendation has more confidence.",
    );
  }

  if (repeatedMissedHighRpe) {
    recommendation.warnings.push("Repeated missed targets with high RPE showed up across recent sessions.");
  }

  if (repeatedHighSessionRpe) {
    recommendation.warnings.push("Repeated high session RPE showed up across recent sessions.");
  }

  if (repeatedHighExerciseRpe) {
    recommendation.warnings.push("Repeated high exercise RPE showed up across recent sessions.");
  }

  if (historySummary.trend === "regressing") {
    recommendation.conservative = true;
    addUniqueReason(
      recommendation,
      "Recent history is regressing, so the next session is kept conservative.",
    );
  }

  if (repeatedHighSessionRpe || repeatedHighExerciseRpe || historySummary.trend === "repeated_high_rpe") {
    recommendation.conservative = true;
    recommendation.confidence = recommendation.confidence === "high" ? "medium" : recommendation.confidence;
  }

  if (recommendation.decision === "increase_load") {
    if (profile.progressionCaps.requiresRepeatTopRange && !twoStrongSessions) {
      return overrideDecision(recommendation, {
        decision: "increase_reps",
        nextWeight: performance.workingWeight,
        repFocus: "Repeat top-range reps before adding load.",
        confidence: "medium",
        conservative: true,
        contextReason:
          "This exercise profile uses especially conservative load jumps, so top-range reps must repeat before adding load.",
      });
    }

    if (mode === "quality_first") {
      recommendation.conservative = true;
      recommendation.confidence = twoStrongSessions ? "medium" : "low";
      addUniqueReason(
        recommendation,
        "Athletic progression stays quality-first; do not chase load unless reps stay crisp.",
      );
      return recommendation;
    }

    if (historySummary.trend === "regressing" || repeatedHighSessionRpe || repeatedHighExerciseRpe) {
      return overrideDecision(recommendation, {
        decision: mode === "reps_first" ? "increase_reps" : "hold",
        nextWeight: performance.workingWeight,
        repFocus:
          mode === "reps_first"
            ? "Confirm clean top-range reps again before adding load."
            : "Confirm this load again before increasing.",
        confidence: "medium",
        conservative: true,
        contextReason:
          "Recent history showed fatigue or regression, so load was not increased off one good session.",
      });
    }

    if (twoStrongSessions) {
      recommendation.confidence = "high";
      addUniqueReason(
        recommendation,
        "Two strong sessions in a row support this load increase.",
        "start",
      );
    } else {
      recommendation.confidence = recommendation.confidence === "high" ? "medium" : recommendation.confidence;
      recommendation.conservative = true;
      addUniqueReason(
        recommendation,
        "One strong session supports only a small progression; repeatability still matters.",
      );
    }
  }

  if (recommendation.decision === "reduce_load") {
    if (!repeatedMissedHighRpe) {
      overrideDecision(recommendation, {
        decision: "hold",
        nextWeight: performance.workingWeight,
        repFocus: "Repeat the load once before reducing unless the same issue repeats.",
        confidence: "medium",
        conservative: true,
        contextReason: "One difficult session usually earns a hold, not an automatic reduction.",
      });
    } else if (classification.isMainCompound && historySummary.consecutiveMissedHighRpe < 2) {
      overrideDecision(recommendation, {
        decision: "hold",
        nextWeight: performance.workingWeight,
        repFocus: "Protect the main lift and reassess before reducing load.",
        confidence: "medium",
        conservative: true,
        contextReason:
          "The main lift is protected from an early reduction; reassess after one more session at this load.",
      });
      recommendation.warnings.push("Main compound load was protected from an aggressive reduction.");
    } else {
      recommendation.confidence = historySummary.consecutiveMissedHighRpe >= 2 ? "high" : "medium";
      addUniqueReason(
        recommendation,
        "Repeated missed targets with high RPE support a small load reduction.",
        "start",
      );
    }
  }

  if (
    recommendation.decision === "hold" &&
    mode === "reps_first" &&
    historySummary.trend === "improving" &&
    !isHighExerciseRpe(performance, 8.5)
  ) {
    overrideDecision(recommendation, {
      decision: "increase_reps",
      repFocus: "Keep load and build reps before increasing weight.",
      confidence: "medium",
      conservative: recommendation.conservative,
      contextReason: "Isolation history is improving, so reps-first progression stays the target.",
    });
  }

  return recommendation;
}

const INCREASE_DECISIONS = new Set(["increase_load", "increase_time", "increase_distance"]);

// A time / distance step that was withdrawn leaves the current range in place.
function clearNextRange(recommendation) {
  delete recommendation.nextRepsMin;
  delete recommendation.nextRepsMax;
  delete recommendation.nextRepsLabel;
}

/**
 * Decision H5-3: a program set to "conservative" aggression caps every
 * decision at hold-or-one-step: a load / time / distance increase needs two
 * strong sessions in a row (the current one and the most recent fresh
 * sample), and a reduction needs twice the usual evidence (two consecutive
 * missed-target / high-RPE samples before the current one instead of one).
 */
function applyProgramAggression({ recommendation, historySummary, performance, profile, mode }) {
  if (profile.aggression !== "conservative") {
    return recommendation;
  }

  const twoStrongSessions = (historySummary.consecutiveStrongSessions ?? 0) >= 1;

  if (INCREASE_DECISIONS.has(recommendation.decision) && !twoStrongSessions) {
    clearNextRange(recommendation);
    return overrideDecision(recommendation, {
      decision: mode === "reps_first" ? "increase_reps" : "hold",
      nextWeight: performance.workingWeight,
      nextSets: performance.targetSets,
      repFocus: "Repeat this performance once more before stepping up.",
      confidence: capConfidence(recommendation.confidence, "medium"),
      conservative: true,
      contextReason:
        "This program is set to conservative progression, so a step up needs two strong sessions in a row.",
    });
  }

  if (recommendation.decision === "reduce_load" && (historySummary.consecutiveMissedHighRpe ?? 0) < 2) {
    clearNextRange(recommendation);
    return overrideDecision(recommendation, {
      decision: "hold",
      nextWeight: performance.workingWeight,
      nextSets: performance.targetSets,
      repFocus: "Repeat the load once more before reducing unless the same issue repeats.",
      confidence: capConfidence(recommendation.confidence, "medium"),
      conservative: true,
      contextReason:
        "This program is set to conservative progression, so a reduction needs the same issue in two more sessions.",
    });
  }

  return recommendation;
}

export const PAIN_FLAG_WARNING =
  "Pain or discomfort was flagged on this exercise. The coach is holding progression - if it keeps showing up, lower the load, swap the movement, or get it checked.";

export function calculateNextRecommendation({
  exercise,
  classification,
  mode,
  performance,
  readinessModifier,
  sessionFatigue,
  historySummary = { trend: "insufficient_history", sampleSize: 0, warnings: [] },
  profile = buildExerciseProfile(exercise),
}) {
  const recommendation = getBaseCoachRecommendation(performance);

  if (!performance.hasMeaningfulData) {
    recommendation.decision = "insufficient_data";
    recommendation.confidence = "low";
    recommendation.repFocus = "Log this next time to establish a baseline.";
    recommendation.nextWeight = performance.plannedWeight;
    recommendation.conservative = true;
    recommendation.reasons.push(
      generateCoachReason(recommendation.decision, {
        mode,
        performance,
        readinessModifier,
        sessionFatigue,
      }),
    );

    if (performance.painFlagged) {
      recommendation.warnings.push(PAIN_FLAG_WARNING);
    }

    delete recommendation.decisionOverridden;
    delete recommendation.contextReason;

    return recommendation;
  }

  if (performance.totalRepsImproved) {
    recommendation.reasons.push(
      `Total reps improved from ${performance.previousTotalReps} to ${performance.totalReps}.`,
    );
  }

  if (isMeasurementMode(mode)) {
    // Decision H5-2: duration / distance progresses first; the load never
    // changes in these modes (an override or a target edit changes it).
    const measurement = mode === "time_first" ? "time" : "distance";
    const range = { unit: performance.unit, perSide: performance.perSide };
    const canProgress =
      performance.allAtTop &&
      isManageableExerciseRpe(performance, profile.rpePolicy.maxForLoadIncrease) &&
      !readinessModifier.isRed &&
      !sessionFatigue.isVeryHigh;
    const nextRange = canProgress
      ? increaseMeasurementRange(measurement, performance.repsMin, performance.repsMax)
      : null;

    recommendation.nextWeight = performance.workingWeight;

    if (nextRange) {
      recommendation.decision = measurement === "time" ? "increase_time" : "increase_distance";
      recommendation.nextRepsMin = nextRange.min;
      recommendation.nextRepsMax = nextRange.max;
      recommendation.nextRepsLabel = formatMeasurementRange({ ...range, min: nextRange.min, max: nextRange.max });
      recommendation.repFocus = `Build every set to ${formatMeasurementRange({ ...range, min: nextRange.max, max: nextRange.max })}.`;
    } else if (performance.belowMin && isHighExerciseRpe(performance)) {
      recommendation.decision = "hold";
      recommendation.repFocus = `Rebuild the ${measurement} target with cleaner effort before adding to it.`;
      recommendation.conservative = true;
    } else if (performance.allAtTop) {
      recommendation.decision = "hold";
      recommendation.repFocus = "Repeat this target with the same control.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus =
        performance.repsMax !== null && performance.repsMax !== undefined
          ? `Bring every set to ${formatMeasurementRange({ ...range, min: performance.repsMax, max: performance.repsMax })}.`
          : `Log the ${measurement} of every set to establish the target.`;
      recommendation.conservative = readinessModifier.isRed;
    }
  } else if (mode === "quality_first") {
    recommendation.warnings.push(
      "No speed or quality metric is logged, so athletic decisions use RPE, readiness, and completion as proxies.",
    );

    const isHangClean =
      exercise.id === "hang-cleans" ||
      exercise.legacyExerciseId === "hang-cleans" ||
      /hang cleans?/i.test(exercise.name ?? "");

    if (
      isHangClean &&
      canIncreaseLoadNow({
        exercise,
        performance,
        readinessModifier,
        sessionFatigue,
        profile,
        maxRpe: 7.5,
      })
    ) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Keep every rep fast and crisp.";
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Prioritize speed and crisp execution over more volume.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    }
  } else if (mode === "core_control") {
    if (canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue, profile })) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Keep control strict with the small jump.";
    } else if (
      performance.allAtTop &&
      isManageableExerciseRpe(performance, profile.rpePolicy.maxForLoadIncrease) &&
      !readinessModifier.isRed &&
      !sessionFatigue.isVeryHigh
    ) {
      recommendation.decision = "increase_reps";
      recommendation.repFocus = "Use slower control or a slightly harder variation.";
    } else if (performance.belowMin && isHighExerciseRpe(performance)) {
      recommendation.decision = "hold";
      recommendation.repFocus = "Rebuild controlled reps before making it harder.";
      recommendation.conservative = true;
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Add quality before load or volume.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    }
  } else if (mode === "reps_first") {
    if (canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue, profile })) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Reset to the lower end and keep reps clean.";
    } else if (performance.belowMin && isHighExerciseRpe(performance)) {
      if (readinessModifier.isRed) {
        recommendation.decision = "hold";
        recommendation.repFocus = "Repeat the load under better recovery.";
      } else {
        recommendation.decision = "reduce_load";
        recommendation.nextWeight = decreaseLoad(performance.workingWeight, exercise, 2.5);
        recommendation.repFocus = "Reclaim the rep range before loading again.";
      }
      recommendation.conservative = true;
    } else if (performance.allAtMin || performance.totalRepsImproved) {
      recommendation.decision = "increase_reps";
      recommendation.repFocus = "Add 1 rep where form stays sharp.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Get every set back into the target range.";
      recommendation.conservative = readinessModifier.isRed;
    }
  } else {
    if (canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue, profile })) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Own the same rep range with the heavier load.";
    } else if ((performance.belowMin || performance.regressed) && isHighExerciseRpe(performance)) {
      if (readinessModifier.isRed) {
        recommendation.decision = "hold";
        recommendation.repFocus = "Repeat the load and reassess under better recovery.";
      } else if (performance.belowMinCount > 1 || performance.exerciseRPE >= 9.5) {
        recommendation.decision = "reduce_load";
        recommendation.nextWeight = decreaseLoad(performance.workingWeight, exercise, 5);
        recommendation.repFocus = "Rebuild the bottom of the range with cleaner reps.";
      } else {
        recommendation.decision = "hold";
        recommendation.repFocus = "Repeat the load and rebuild clean reps.";
      }
      recommendation.conservative = true;
    } else if (performance.allAtMin || performance.totalRepsImproved) {
      if (
        isHighExerciseRpe(performance, profile.rpePolicy.maxForLoadIncrease) ||
        (classification.isMainCompound && (readinessModifier.isRed || sessionFatigue.isVeryHigh))
      ) {
        recommendation.decision = "hold";
        recommendation.repFocus =
          performance.totalReps !== null
            ? `Repeat ${performance.totalReps} total reps with cleaner fatigue.`
            : "Repeat this load before pushing progression.";
        recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
      } else {
        recommendation.decision = "increase_reps";
        recommendation.repFocus =
          performance.totalReps !== null
            ? `Beat ${performance.totalReps} total reps next time.`
            : "Beat last session's total reps.";
        recommendation.conservative = false;
      }
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Keep load and build total reps before adding weight.";
      recommendation.conservative = readinessModifier.isRed;
    }
  }

  if (
    sessionFatigue.isVeryHigh &&
    readinessModifier.isRed &&
    profile.volumePolicy.canAutoReduceVolume &&
    recommendation.nextSets > 1
  ) {
    recommendation.decision = "reduce_volume";
    recommendation.nextSets = Math.max(1, recommendation.nextSets - 1);
    recommendation.nextWeight = performance.workingWeight;
    recommendation.repFocus = "Keep quality high with 1 less accessory set.";
    recommendation.conservative = true;
  }

  if (
    (readinessModifier.isRed || sessionFatigue.isVeryHigh) &&
    recommendation.decision === "increase_load"
  ) {
    recommendation.decision = "hold";
    recommendation.nextWeight = performance.workingWeight;
    recommendation.repFocus = "Confirm this performance again before increasing load.";
    recommendation.conservative = true;
  }

  const primaryReason = generateCoachReason(recommendation.decision, {
    mode,
    performance,
    readinessModifier,
    sessionFatigue,
  });

  recommendation.reasons = [
    primaryReason,
    ...recommendation.reasons.filter((reason) => reason !== primaryReason),
  ];
  recommendation.confidence = getConfidence({
    performance,
    decision: recommendation.decision,
    mode,
  });

  if (readinessModifier.isMissing) {
    recommendation.warnings.push("No readiness snapshot was available, so readiness was treated as neutral.");
  }

  applyHistoryContext({
    classification,
    mode,
    performance,
    recommendation,
    historySummary,
    sessionFatigue,
    profile,
  });

  applyProgramAggression({ recommendation, historySummary, performance, profile, mode });

  // Pain handling runs after history and stays independent of it. It is the
  // most important context for the athlete, so it becomes the one context
  // sentence next to the final decision's primary reason.
  if (performance.painFlagged) {
    if (INCREASE_DECISIONS.has(recommendation.decision) || recommendation.decision === "increase_reps") {
      recommendation.decision = "hold";
      recommendation.nextWeight = performance.workingWeight;
      clearNextRange(recommendation);
    }

    // The pain sentence takes the single context slot; a context sentence that
    // history already supplied (the long-break explanation of decision new-B)
    // must still reach the athlete, so it moves to the warnings.
    if (historySummary.longBreak && recommendation.contextReason) {
      recommendation.warnings.push(recommendation.contextReason);
    }

    overrideDecision(recommendation, {
      decision: recommendation.decision,
      repFocus: "Stay in a pain-free range and cut a set short the moment it flares up.",
      conservative: true,
      contextReason:
        recommendation.decision === "hold"
          ? "You flagged pain or discomfort here, so progression is on hold until a pain-free session is logged."
          : "You flagged pain or discomfort here, so nothing is added until a pain-free session is logged.",
    });
    recommendation.warnings.push(PAIN_FLAG_WARNING);
  }

  const finalPrimaryReason = generateCoachReason(recommendation.decision, {
    mode,
    performance,
    readinessModifier,
    sessionFatigue,
  });

  // Whenever the decision changed after the first reason pass, rebuild the
  // list: exactly one primary reason for the final decision plus at most one
  // context sentence. Otherwise keep the supporting reasons that were added.
  recommendation.reasons = recommendation.decisionOverridden
    ? [finalPrimaryReason, recommendation.contextReason].filter(Boolean)
    : [
        finalPrimaryReason,
        ...recommendation.reasons.filter((reason) => reason && reason !== finalPrimaryReason),
      ];
  recommendation.warnings = [...new Set(recommendation.warnings.filter(Boolean))];
  delete recommendation.decisionOverridden;
  delete recommendation.contextReason;

  return recommendation;
}

function calculateExerciseRecommendationV2(
  exercise,
  session,
  previousSessions,
  wellnessSummary,
  dayId,
  identity = {},
) {
  const planned = getPlannedExerciseSnapshot(session, exercise) ?? {};
  const candidateSessions = Array.isArray(previousSessions)
    ? previousSessions
    : previousSessions
      ? [previousSessions]
      : [];
  const classification = classifyExerciseType(exercise);
  const profile = buildExerciseProfile(exercise);
  const mode = profile.progressionMode;
  const readinessModifier = evaluateReadinessModifier(wellnessSummary);
  const sessionFatigue = evaluateSessionFatigue(session.sessionRpe);
  // Strict identity + recency selection. The previous-session comparison uses
  // the most recent fresh sample only; after a long break there is none.
  const history = selectExerciseHistory(dayId, exercise, session, candidateSessions, identity);
  const performance = evaluateExercisePerformance({
    exercise,
    session,
    previousExerciseSession: history.sessions[0] ?? null,
    planned,
    identity,
  });
  const historySummary = evaluateExerciseHistory({
    exercise,
    dayId,
    session,
    previousSessions: candidateSessions,
    planned,
    identity,
  });
  const recommendation = calculateNextRecommendation({
    exercise,
    classification,
    mode,
    performance,
    readinessModifier,
    sessionFatigue,
    historySummary,
    profile,
  });

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    sets: recommendation.nextSets,
    // Decision H5-2: a time / distance step moves the target range itself.
    repsMin: recommendation.nextRepsMin !== undefined ? recommendation.nextRepsMin : performance.repsMin,
    repsMax: recommendation.nextRepsMax !== undefined ? recommendation.nextRepsMax : performance.repsMax,
    repsLabel: recommendation.nextRepsLabel !== undefined ? recommendation.nextRepsLabel : performance.repsLabel,
    restSeconds: planned.restSeconds ?? exercise.restSeconds,
    targetRPE: performance.targetRPE,
    recommendedWeight: recommendation.nextWeight,
    previousWeight: performance.previousWeight,
    repFocus: recommendation.repFocus,
    totalReps: performance.totalReps,
    previousTotalReps: performance.previousTotalReps,
    exerciseRPE: performance.exerciseRPE,
    reasons: recommendation.reasons.length
      ? recommendation.reasons
      : [
          generateCoachReason(recommendation.decision, {
            mode,
            performance,
            readinessModifier,
            sessionFatigue,
          }),
        ],
    conservative: recommendation.conservative,
    decision: recommendation.decision,
    confidence: recommendation.confidence,
    warnings: [...new Set(recommendation.warnings.filter(Boolean))],
    historyTrend: recommendation.historyTrend,
    historySampleSize: recommendation.historySampleSize,
    progressionMode: profile.progressionMode,
    exerciseProfile: getSerializableExerciseProfile(profile),
  };
}
