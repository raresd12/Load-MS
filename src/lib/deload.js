// Program-level fatigue / deload suggestion (Phase H5, decision H5-7).
//
// evaluateDeloadNeed is deterministic: it reads the sessions and readiness
// check-ins it is given, never the clock (pass `now`). Its reasons are
// observations with their sample counts, never a diagnosis or a medical
// claim. A suggestion is only made once the sample requirement is met (at
// least 6 saved sessions of the program within 21 days AND at least 4
// readiness check-ins in that window).
//
// An applied deload lives on ProgramState.deload = { level, remainingSessions,
// totalSessions, startedAt }. The prescription resolver scales the resolved
// load by the level's factor (0.9 lighter week / 0.85 deload, rounded to the
// equipment step) and takes one set off accessory exercises; the engine
// treats a session logged under a deload as no progression evidence (plan
// status "deload", every exercise a hold), so the stored progression keeps
// the base loads and the scaling never compounds. persistWorkoutSave
// decrements remainingSessions per saved training session and clears the
// record at 0. Nothing here touches sessions.
import {
  buildExerciseProfile,
  DELOAD_FACTORS,
  evaluateExerciseHistory,
  interpretWellness,
  isDeloadActive,
  roundLoadForProfile,
} from "./progression.js";
import { getProgramState, updateProgramStateChecked } from "./programStorage.js";

export const DELOAD_LEVELS = Object.freeze(["lighter_week", "deload"]);
export const DELOAD_SESSION_OPTIONS = Object.freeze([2, 3]);
export const DELOAD_WINDOW_DAYS = 21;
export const DELOAD_REQUIRED_SESSIONS = 6;
export const DELOAD_REQUIRED_CHECK_INS = 4;
export const DELOAD_DISMISS_DAYS = 7;
export const DELOAD_SIGNAL_KEYS = Object.freeze([
  "high_session_rpe",
  "red_readiness",
  "regressing_main_lifts",
  "pain_flags",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function toIso(value) {
  const time = toTimestamp(value);
  return time === null ? null : new Date(time).toISOString();
}

export function getDeloadFactor(level) {
  return DELOAD_FACTORS[level] ?? null;
}

export function describeDeloadLevel(level) {
  return level === "deload" ? "deload" : "lighter week";
}

/**
 * describeDeload(deload) -> "Lighter week (2 sessions left)" | "Deload (1 session left)" | "".
 */
export function describeDeload(deload) {
  if (!isDeloadActive(deload)) {
    return "";
  }

  const label = deload.level === "deload" ? "Deload" : "Lighter week";
  const remaining = deload.remainingSessions;

  if (Number.isFinite(remaining)) {
    return `${label} (${remaining} ${remaining === 1 ? "session" : "sessions"} left)`;
  }

  return label;
}

/**
 * Pure: the prescription a deload turns { weight, sets } into for one
 * exercise (a day view model exercise or a raw record with the profile
 * fields). Returns { weight, sets, baseWeight, baseSets, factor, level,
 * setsReduced }. A non-numeric weight (BW, null) stays as it is; only an
 * accessory (role "accessory") with more than one set loses a set.
 */
export function applyDeloadToPrescription({ weight, sets, exercise = {}, deload }) {
  if (!isDeloadActive(deload)) {
    return { weight, sets, baseWeight: weight, baseSets: sets, factor: null, level: null, setsReduced: false };
  }

  const factor = DELOAD_FACTORS[deload.level];
  const profile = buildExerciseProfile(exercise);
  const numericWeight = typeof weight === "number" && Number.isFinite(weight) ? weight : null;
  const scaledWeight = numericWeight === null ? weight : scaleDeloadWeight(profile, numericWeight, factor);
  const numericSets = Number.isFinite(Number(sets)) ? Number(sets) : null;
  const setsReduced = profile.role === "accessory" && numericSets !== null && numericSets > 1;

  return {
    weight: scaledWeight,
    sets: setsReduced ? numericSets - 1 : sets,
    baseWeight: weight,
    baseSets: sets,
    factor,
    level: deload.level,
    setsReduced,
    // H5 fix round 1: true when the equipment step left the load as it was
    // (the base load is at or under one step), so the detail never claims a
    // reduction that did not happen.
    weightUnchanged: numericWeight !== null && scaledWeight === numericWeight,
  };
}

// weight x factor rounded to the equipment step, and at least one step
// under the base load whenever the base load is above one step: nearest-step
// rounding alone left 2.5-12.5 kg barbell / cable loads and 5-25 kg stack
// loads untouched while the detail said "load 10% lighter" (H5 fix round 1).
function scaleDeloadWeight(profile, weight, factor) {
  const rounded = Math.max(0, roundLoadForProfile(profile, weight * factor, "round") ?? weight * factor);

  if (rounded < weight) {
    return rounded;
  }

  const oneStepDown = Math.max(0, roundLoadForProfile(profile, weight - 1e-6, "floor") ?? weight);

  if (oneStepDown < weight && oneStepDown > 0) {
    return oneStepDown;
  }

  return weight;
}

function getSessionReadinessStatus(session) {
  return (
    session?.readiness?.status ??
    session?.readinessSnapshot?.readiness?.status ??
    (session?.wellness ? interpretWellness(session.wellness).status : null)
  );
}

function getCheckInStatus(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return entry.readiness?.status ?? (entry.wellness ? interpretWellness(entry.wellness).status : null);
}

function sessionHasPainFlag(session) {
  const logs = session?.exercises;
  const fromLogs = Array.isArray(logs)
    ? logs.some((log) => Boolean(log?.painFlag))
    : logs && typeof logs === "object"
      ? Object.values(logs).some((log) => Boolean(log?.painFlag))
      : false;
  const fromSets = Array.isArray(session?.workoutSets) && session.workoutSets.some((set) => Boolean(set?.painFlag));

  return fromLogs || fromSets;
}

function countRegressingMainExercises(program, days, programSessions) {
  let count = 0;
  const names = [];

  (days ?? []).forEach((day) => {
    const daySessions = programSessions
      .filter((session) => session.dayId === day.id)
      .sort((left, right) => toTimestamp(right.date) - toTimestamp(left.date));

    if (daySessions.length < 3) {
      return;
    }

    const [current, ...previous] = daySessions;

    (day.exercises ?? []).forEach((exercise) => {
      const profile = buildExerciseProfile(exercise);

      if (profile.role !== "main") {
        return;
      }

      const history = evaluateExerciseHistory({
        exercise,
        dayId: day.id,
        session: current,
        previousSessions: previous,
      });

      if (history.sampleSize >= 2 && history.trend === "regressing") {
        count += 1;
        names.push(exercise.name);
      }
    });
  });

  return { count, names };
}

/**
 * evaluateDeloadNeed({ program, days, sessions, readinessByDate, now, state })
 * -> { eligible, sampleSize: { sessions, checkIns }, requiredSampleSize,
 *      suggest, level, signals: [{ key, met, detail }], reasons, suppressed,
 *      active, windowDays }
 *
 * program: the program record; days: its day view models (isOptional,
 * exercises with the profile fields); sessions: every saved session
 * (filtered to the program here); readinessByDate: the check-in map keyed by
 * local date; now: Date / ISO / epoch (required for determinism); state: the
 * ProgramState (active deload, dismissed suggestion).
 *
 * Signals: session RPE >= 9 in at least 3 of the last 4 sessions; readiness
 * red in at least 3 of the last 5 check-ins; at least two main exercises
 * with a regressing trend over their last 3 comparable sessions; pain flags
 * on 2+ sessions in the window. suggest = eligible and 2+ signals
 * ("lighter_week"), 3+ signals ("deload"). A suggestion dismissed within the
 * last 7 days is suppressed unless a signal that was not met at dismissal
 * is met now.
 */
export function evaluateDeloadNeed({ program, days = [], sessions = [], readinessByDate = {}, now, state = null } = {}) {
  const programId = program?.id ?? null;
  const reference = toTimestamp(now) ?? 0;
  // H5 fix round 1 (decision H5-16): the observations that were acted on by
  // the last deload do not count again. The window starts after that deload
  // ended (ProgramState.lastDeload.endedAt: the date of its last session, or
  // the moment it was ended early), when that is later than 21 days ago.
  const lastDeloadEnded = toTimestamp(state?.lastDeload?.endedAt);
  const windowStart = Math.max(reference - DELOAD_WINDOW_DAYS * DAY_MS, lastDeloadEnded === null ? -Infinity : lastDeloadEnded + 1);
  const programSessions = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.programId === programId)
    .filter((session) => {
      const time = toTimestamp(session.date);
      return time !== null && time >= windowStart && time <= reference;
    })
    .sort((left, right) => toTimestamp(right.date) - toTimestamp(left.date));
  const checkIns = Object.entries(readinessByDate && typeof readinessByDate === "object" ? readinessByDate : {})
    .map(([date, entry]) => ({ date, time: toTimestamp(`${date}T12:00:00Z`) ?? toTimestamp(date), entry }))
    .filter((item) => item.time !== null && item.time >= windowStart && item.time <= reference + DAY_MS)
    .sort((left, right) => right.time - left.time);

  const lastFour = programSessions.slice(0, 4);
  const highRpeCount = lastFour.filter((session) => Number(session.sessionRpe) >= 9).length;
  const lastFiveCheckIns = checkIns.slice(0, 5);
  const redCount = lastFiveCheckIns.filter((item) => getCheckInStatus(item.entry) === "red").length;
  const regressing = countRegressingMainExercises(program, days, programSessions);
  const painCount = programSessions.filter(sessionHasPainFlag).length;

  const signals = [
    {
      key: "high_session_rpe",
      met: lastFour.length >= 3 && highRpeCount >= 3,
      detail: `Session RPE was 9 or higher in ${highRpeCount} of the last ${lastFour.length} sessions.`,
    },
    {
      key: "red_readiness",
      met: lastFiveCheckIns.length >= 3 && redCount >= 3,
      detail: `Readiness was red in ${redCount} of the last ${lastFiveCheckIns.length} check-ins.`,
    },
    {
      key: "regressing_main_lifts",
      met: regressing.count >= 2,
      detail:
        regressing.count > 0
          ? `${regressing.count} main ${regressing.count === 1 ? "exercise is" : "exercises are"} trending down over their last 3 comparable sessions (${regressing.names.join(", ")}).`
          : "No main exercise is trending down over its last 3 comparable sessions.",
    },
    {
      key: "pain_flags",
      met: painCount >= 2,
      detail: `Pain or discomfort was flagged in ${painCount} ${painCount === 1 ? "session" : "sessions"} in the last ${DELOAD_WINDOW_DAYS} days.`,
    },
  ];
  const metSignals = signals.filter((signal) => signal.met);
  const sampleSize = { sessions: programSessions.length, checkIns: checkIns.length };
  const requiredSampleSize = { sessions: DELOAD_REQUIRED_SESSIONS, checkIns: DELOAD_REQUIRED_CHECK_INS };
  const eligible =
    sampleSize.sessions >= requiredSampleSize.sessions && sampleSize.checkIns >= requiredSampleSize.checkIns;
  const active = isDeloadActive(state?.deload);
  const dismissedAt = toTimestamp(state?.deloadSuggestion?.dismissedAt);
  const dismissedSignals = new Set(Array.isArray(state?.deloadSuggestion?.signals) ? state.deloadSuggestion.signals : []);
  const recentlyDismissed = dismissedAt !== null && reference - dismissedAt < DELOAD_DISMISS_DAYS * DAY_MS;
  const newSignal = metSignals.some((signal) => !dismissedSignals.has(signal.key));
  const suppressed = recentlyDismissed && !newSignal;
  const wouldSuggest = eligible && metSignals.length >= 2;
  const suggest = wouldSuggest && !active && !suppressed;
  const level = wouldSuggest ? (metSignals.length >= 3 ? "deload" : "lighter_week") : null;
  const reasons = [];

  if (!eligible) {
    reasons.push(
      `Not enough data yet: ${sampleSize.sessions} of ${requiredSampleSize.sessions} sessions and ${sampleSize.checkIns} of ${requiredSampleSize.checkIns} readiness check-ins in the last ${DELOAD_WINDOW_DAYS} days.`,
    );
  }

  metSignals.forEach((signal) => reasons.push(signal.detail));

  if (wouldSuggest && active) {
    reasons.push(`A ${describeDeloadLevel(state.deload.level)} is already in progress.`);
  } else if (wouldSuggest && suppressed) {
    reasons.push("The same observations were dismissed less than 7 days ago.");
  } else if (eligible && !wouldSuggest) {
    reasons.push(`${metSignals.length} of ${signals.length} fatigue observations are present; a suggestion needs at least 2.`);
  }

  return {
    eligible,
    sampleSize,
    requiredSampleSize,
    suggest,
    level,
    signals,
    reasons,
    suppressed,
    active,
    windowDays: DELOAD_WINDOW_DAYS,
    // The start of the observation window actually used (ISO), so the UI can
    // say "since your last deload" when it is later than 21 days ago.
    windowStart: new Date(Number.isFinite(windowStart) ? windowStart : reference - DELOAD_WINDOW_DAYS * DAY_MS).toISOString(),
    sinceLastDeload: lastDeloadEnded !== null && lastDeloadEnded + 1 > reference - DELOAD_WINDOW_DAYS * DAY_MS,
  };
}

/**
 * The ProgramState.lastDeload record written when a deload ends (H5 fix
 * round 1, decision H5-16): { level, startedAt, endedAt, totalSessions,
 * completedSessions }. `endedAt` is the date of the session that used the
 * last deload session, or `now` for an early end.
 */
export function buildLastDeloadRecord(deload, { endedAt, completedSessions = null } = {}) {
  if (!deload || typeof deload !== "object") {
    return null;
  }

  const total = Number.isFinite(deload.totalSessions) ? deload.totalSessions : null;
  const remaining = Number.isFinite(deload.remainingSessions) ? deload.remainingSessions : null;

  return {
    level: deload.level ?? null,
    startedAt: toIso(deload.startedAt),
    endedAt: toIso(endedAt) ?? null,
    totalSessions: total,
    completedSessions:
      completedSessions ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null),
  };
}

/**
 * The deload record after one training session was saved under it:
 * remainingSessions - 1, or null when the deload is over.
 */
export function consumeDeloadSession(deload) {
  if (!isDeloadActive(deload)) {
    return null;
  }

  if (!Number.isFinite(deload.remainingSessions)) {
    return deload;
  }

  const remaining = deload.remainingSessions - 1;
  return remaining >= 1 ? { ...deload, remainingSessions: remaining } : null;
}

/**
 * applyProgramDeload({ programId, level, sessions, now }) -> { ok: true, state }
 * or { ok: false, error, code? }. Checked write of ProgramState.deload.
 */
export function applyProgramDeload({ programId, level, sessions = 2, now = new Date() } = {}) {
  if (!programId) {
    return { ok: false, error: "Program id is required.", code: "invalid" };
  }

  if (!DELOAD_LEVELS.includes(level)) {
    return { ok: false, error: `Deload level must be one of ${DELOAD_LEVELS.join(", ")}.`, code: "invalid" };
  }

  if (!DELOAD_SESSION_OPTIONS.includes(sessions)) {
    return { ok: false, error: `Deload length must be ${DELOAD_SESSION_OPTIONS.join(" or ")} sessions.`, code: "invalid" };
  }

  return updateProgramStateChecked(programId, {
    deload: {
      level,
      remainingSessions: sessions,
      totalSessions: sessions,
      startedAt: toIso(now),
    },
  });
}

/**
 * endProgramDeload(programId, { now }) -> { ok, state } clears an active
 * deload early and records it as `lastDeload` (ended at `now`), so the
 * observations it answered are not re-suggested at once (H5-16).
 */
export function endProgramDeload(programId, { now = new Date() } = {}) {
  const current = getProgramState(programId)?.deload ?? null;
  const patch = { deload: null };

  if (isDeloadActive(current)) {
    patch.lastDeload = buildLastDeloadRecord(current, { endedAt: now });
  }

  return updateProgramStateChecked(programId, patch);
}

/**
 * dismissDeloadSuggestion(programId, { signals, now }) -> { ok, state }.
 * Records the dismissal and the signal keys that were met, so the same
 * window does not nag (re-suggested after 7 days or on a new signal).
 */
export function dismissDeloadSuggestion(programId, { signals = [], now = new Date() } = {}) {
  const keys = (Array.isArray(signals) ? signals : [])
    .map((signal) => (typeof signal === "string" ? signal : signal?.key))
    .filter((key) => DELOAD_SIGNAL_KEYS.includes(key));

  return updateProgramStateChecked(programId, {
    deloadSuggestion: { dismissedAt: toIso(now), signals: keys },
  });
}

export function getProgramDeload(programId) {
  const deload = getProgramState(programId)?.deload ?? null;
  return isDeloadActive(deload) ? deload : null;
}
