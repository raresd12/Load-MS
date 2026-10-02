// Personal records by exercise identity (Phase H5, decision H5-8).
//
// The primary identity is programId + programExerciseId (handoff 3.1 / 19.1):
// a set logged in another program, or against a retired occurrence id, never
// becomes a record of this occurrence. A secondary roll-up by Library
// exerciseId (and the same measurement + weight mode) is reported apart,
// labelled "across programs", and is never merged into the primary.
//
// Record types: best_e1rm (eligibility of getE1rmEligibility), best_weight,
// best_reps_at_weight (map weight -> best reps, "BW" for bodyweight sets),
// best_session_volume (measurement-aware tonnage), best_time (longest
// completed seconds at the top weight), best_distance (longest meters at the
// top weight). Ties keep the earlier record; detectNewRecords reports a tie.
// Legacy sets without ids attach to an occurrence only when the Library id /
// name is unique across the given program exercises. Nothing here reads
// storage. Fixture: scripts/verify-personal-records.mjs.
import { MEASUREMENT_UNITS } from "./measurement.js";
import {
  buildExerciseLookupFromEntries,
  E1RM_ELIGIBILITY,
  getDateTime,
  getSessionSetRecords,
} from "./sessionAnalytics.js";

export { E1RM_ELIGIBILITY };

export const PERSONAL_RECORD_TYPES = Object.freeze([
  "best_e1rm",
  "best_weight",
  "best_reps_at_weight",
  "best_session_volume",
  "best_time",
  "best_distance",
]);

export const RECORD_SCOPES = Object.freeze({
  program: "program",
  acrossPrograms: "across programs",
});

export function getRecordIdentityKey(programId, programExerciseId) {
  return `${programId}::${programExerciseId}`;
}

/**
 * Roll-up key by Library id and the profile the sets were logged under.
 * Per side and a non-external load type change what tonnage and e1RM mean
 * (H5-20), so they split the roll-up too (decision H5-48); the key of a
 * two-sided external-load exercise is unchanged.
 */
export function getRecordRollupKey(exerciseId, measurement = "reps", weightMode = "kg", { perSide = false, loadType = "external" } = {}) {
  return `${exerciseId}::${measurement}::${weightMode}${perSide ? "::per side" : ""}${
    loadType && loadType !== "external" ? `::${loadType}` : ""
  }`;
}

/** The profile a set record (or an identity) is compared under (H5-48). */
function getRecordProfile(source) {
  return {
    measurement: source?.measurement ?? "reps",
    weightMode: source?.weightMode ?? "kg",
    perSide: Boolean(source?.perSide),
    loadType: source?.loadType ?? "external",
  };
}

function sameRecordProfile(left, right) {
  const a = getRecordProfile(left);
  const b = getRecordProfile(right);
  return (
    a.measurement === b.measurement &&
    a.weightMode === b.weightMode &&
    a.perSide === b.perSide &&
    a.loadType === b.loadType
  );
}

function describeRecordProfile(source) {
  const profile = getRecordProfile(source);
  return `${profile.measurement} / ${profile.weightMode}${profile.perSide ? " / per side" : ""}${
    profile.loadType !== "external" ? ` / ${profile.loadType}` : ""
  }`;
}

function repsLabelOf(targetReps) {
  if (!targetReps || typeof targetReps !== "object") {
    return null;
  }
  if (targetReps.label) {
    return targetReps.label;
  }
  if (targetReps.min !== null && targetReps.min !== undefined && targetReps.max !== null && targetReps.max !== undefined) {
    return targetReps.min === targetReps.max ? String(targetReps.min) : `${targetReps.min}-${targetReps.max}`;
  }
  return null;
}

/**
 * A raw ProgramExercise record ({ id, programId, exerciseId, targetSets,
 * targetReps, ... }) or a day view model ({ programExerciseId,
 * libraryExerciseId, name, sets, repsLabel, ... }) as the lookup expects.
 */
function toLookupExercise(programExercise, libraryById) {
  const isViewModel =
    programExercise?.programExerciseId !== undefined ||
    programExercise?.libraryExerciseId !== undefined ||
    programExercise?.repsLabel !== undefined;

  if (isViewModel) {
    return {
      ...programExercise,
      id: programExercise.id ?? programExercise.programExerciseId,
      programExerciseId: programExercise.programExerciseId ?? programExercise.id,
      name:
        programExercise.name ??
        libraryById.get(programExercise.libraryExerciseId ?? programExercise.legacyExerciseId)?.name ??
        "Exercise",
      sets: programExercise.sets ?? null,
      repsLabel: programExercise.repsLabel ?? null,
      targetRPE: programExercise.targetRPE ?? null,
      restSeconds: programExercise.restSeconds ?? null,
      recommendedWeight: programExercise.recommendedWeight ?? null,
    };
  }

  const library = libraryById.get(programExercise?.exerciseId);

  return {
    id: programExercise.id,
    programExerciseId: programExercise.id,
    libraryExerciseId: programExercise.exerciseId ?? null,
    legacyExerciseId: programExercise.exerciseId ?? null,
    programId: programExercise.programId ?? null,
    dayId: programExercise.dayId ?? null,
    name: library?.name ?? programExercise.name ?? "Exercise",
    category: library?.category ?? "compound",
    sets: programExercise.targetSets ?? null,
    repsMin: programExercise.targetReps?.min ?? null,
    repsMax: programExercise.targetReps?.max ?? null,
    repsLabel: repsLabelOf(programExercise.targetReps),
    targetRPE: programExercise.targetRPE ?? null,
    restSeconds: programExercise.restTime ?? null,
    recommendedWeight: programExercise.targetWeight ?? null,
    loadType: programExercise.loadType ?? (library?.equipment === "bodyweight" ? "bodyweight" : "external"),
    weightMode: programExercise.weightMode ?? "kg",
    measurement: programExercise.measurement,
    perSide: programExercise.perSide,
  };
}

/**
 * buildRecordsLookup({ programs, programExercises, exerciseLibrary, activeProgram })
 * The identity lookup of sessionAnalytics.js built without storage access.
 */
export function buildRecordsLookup({ programs = [], programExercises = [], exerciseLibrary = [], activeProgram = null } = {}) {
  const programsById = new Map((programs ?? []).map((program) => [program.id, program]));
  const libraryById = new Map((exerciseLibrary ?? []).map((exercise) => [exercise.id, exercise]));
  const entries = (programExercises ?? [])
    .filter((programExercise) => programExercise && typeof programExercise === "object")
    .map((programExercise) => {
      const exercise = toLookupExercise(programExercise, libraryById);
      const programId = exercise.programId ?? activeProgram?.id ?? null;
      const program = programsById.get(programId) ?? (programId ? { id: programId } : null);

      return {
        program,
        day: exercise.dayId ? { id: exercise.dayId } : null,
        exercise: { ...exercise, programId },
      };
    });

  return buildExerciseLookupFromEntries({ entries, activeProgram, exerciseLibrary });
}

function createIdentity({ identityKey, scope, programId, programExerciseId, exerciseId, name, measurement, weightMode, perSide = false, loadType = "external" }) {
  return {
    identityKey,
    scope,
    programId: programId ?? null,
    programExerciseId: programExerciseId ?? null,
    exerciseId: exerciseId ?? null,
    name: name ?? "Exercise",
    measurement,
    weightMode,
    perSide: Boolean(perSide),
    loadType: loadType ?? "external",
    unit: MEASUREMENT_UNITS[measurement] ?? "reps",
    sessionCount: 0,
    records: {
      best_e1rm: null,
      best_weight: null,
      best_reps_at_weight: {},
      best_session_volume: null,
      best_time: null,
      best_distance: null,
    },
    ineligibleSets: [],
  };
}

function makeRecord(identity, record, type, value, unit, extra = {}) {
  return {
    type,
    value,
    unit,
    sessionId: record.sessionId ?? null,
    date: record.date ?? null,
    setIndex: record.setNumber ?? null,
    weight: record.weight ?? null,
    rpe: Number.isFinite(record.rpe) ? record.rpe : null,
    eligible: true,
    scope: identity.scope,
    identityKey: identity.identityKey,
    programId: identity.programId,
    programExerciseId: identity.programExerciseId,
    exerciseId: identity.exerciseId,
    exerciseName: identity.name,
    measurement: identity.measurement,
    weightMode: identity.weightMode,
    perSide: identity.perSide,
    loadType: identity.loadType,
    ...extra,
  };
}

// The comparable value of an EARLIER session that a record replaces (H5-50):
// a better set later in the same session keeps what stood before the session.
function previousValueOf(current, record) {
  if (!current) {
    return null;
  }
  return current.sessionId === (record?.sessionId ?? null) ? current.previousValue ?? null : current.value;
}

function weightRank(weight) {
  return typeof weight === "number" ? weight : -1;
}

function considerSet(identity, record) {
  const measurement = record.measurement ?? "reps";

  if (measurement === "reps") {
    const eligibility = record.e1rmEligibility ?? { eligible: false, reason: "No eligibility data" };

    if (eligibility.eligible && Number.isFinite(record.estimatedOneRepMax)) {
      const current = identity.records.best_e1rm;
      if (!current || record.estimatedOneRepMax > current.value) {
        identity.records.best_e1rm = makeRecord(identity, record, "best_e1rm", record.estimatedOneRepMax, "kg", {
          reps: record.reps,
          previousValue: previousValueOf(current, record),
        });
      }
    } else if (
      typeof record.weight === "number" ||
      (identity.measurement === "reps" && record.loadType !== "bodyweight" && record.weight !== "BW")
    ) {
      // Structural cases (a bodyweight exercise, a timed set) are not listed
      // per set; a numeric-load set that misses the reps / RPE rule is.
      identity.ineligibleSets.push({
        type: "best_e1rm",
        sessionId: record.sessionId ?? null,
        date: record.date ?? null,
        setIndex: record.setNumber ?? null,
        reps: record.reps,
        weight: record.weight,
        rpe: Number.isFinite(record.rpe) ? record.rpe : null,
        reason: eligibility.reason,
      });
    }

    if (typeof record.weight === "number" && Number.isFinite(record.reps) && record.reps >= 1) {
      const current = identity.records.best_weight;
      if (!current || record.weight > current.value) {
        identity.records.best_weight = makeRecord(identity, record, "best_weight", record.weight, "kg", {
          reps: record.reps,
          previousValue: previousValueOf(current, record),
        });
      }
    }

    if (Number.isFinite(record.reps) && record.reps >= 1 && (typeof record.weight === "number" || record.weight === "BW")) {
      const weightKey = typeof record.weight === "number" ? String(record.weight) : "BW";
      const current = identity.records.best_reps_at_weight[weightKey];
      if (!current || record.reps > current.value) {
        identity.records.best_reps_at_weight[weightKey] = makeRecord(
          identity,
          record,
          "best_reps_at_weight",
          record.reps,
          "reps",
          { reps: record.reps, weightKey, previousValue: previousValueOf(current, record) },
        );
      }
    }

    return;
  }

  if (measurement === "time" && Number.isFinite(record.seconds) && record.seconds > 0) {
    const current = identity.records.best_time;
    const rank = weightRank(record.weight);
    if (
      !current ||
      rank > weightRank(current.weight) ||
      (rank === weightRank(current.weight) && record.seconds > current.value)
    ) {
      identity.records.best_time = makeRecord(identity, record, "best_time", record.seconds, "s", {
        seconds: record.seconds,
        previousValue: previousValueOf(current, record),
      });
    }
    return;
  }

  if (measurement === "distance" && Number.isFinite(record.meters) && record.meters > 0) {
    const current = identity.records.best_distance;
    const rank = weightRank(record.weight);
    if (
      !current ||
      rank > weightRank(current.weight) ||
      (rank === weightRank(current.weight) && record.meters > current.value)
    ) {
      identity.records.best_distance = makeRecord(identity, record, "best_distance", record.meters, "m", {
        meters: record.meters,
        previousValue: previousValueOf(current, record),
      });
    }
  }
}

function considerSessionVolume(identity, session, records) {
  const tonnage = records.reduce(
    (total, record) => total + (Number.isFinite(record.tonnage) ? record.tonnage : 0),
    0,
  );
  identity.sessionCount += 1;

  if (tonnage <= 0) {
    return;
  }

  const current = identity.records.best_session_volume;
  if (!current || tonnage > current.value) {
    identity.records.best_session_volume = {
      ...makeRecord(identity, { sessionId: records[0].sessionId, date: records[0].date }, "best_session_volume", tonnage, "kg"),
      setIndex: null,
      weight: null,
      rpe: null,
      setCount: records.length,
      previousValue: previousValueOf(current, records[0]),
    };
  }
}

/**
 * Where a completed set record belongs (H5-8): the primary identity key, or
 * null when the set cannot be attributed unambiguously.
 */
export function attributeRecordIdentity(record, lookup) {
  const via = record.identitySource ?? "none";

  if (via === "exact") {
    return { key: getRecordIdentityKey(record.programId, record.programExerciseId), reason: null };
  }

  if (via === "loose") {
    // The set carries an occurrence id that is not an exercise of its own
    // program: a retired occurrence or a foreign program's id. It keeps its
    // own identity when the session names a program; a legacy session without
    // a program attaches only when the occurrence id is unique.
    if (record.programId) {
      return { key: getRecordIdentityKey(record.programId, record.programExerciseId), reason: null };
    }
    const count = lookup.programExerciseIdCounts?.get(record.programExerciseId) ?? 0;
    if (count === 1) {
      const entry = lookup.byLooseProgramExercise.get(record.programExerciseId);
      return { key: getRecordIdentityKey(entry.programId, entry.programExerciseId), reason: null };
    }
    return { key: null, reason: "legacy occurrence id matches more than one program exercise" };
  }

  if (via === "library" || via === "name") {
    const countMap = via === "library" ? lookup.exerciseIdCounts : lookup.exerciseNameCounts;
    const lookupKey = via === "library" ? record.exerciseId : String(record.exerciseName ?? "").trim().toLowerCase();
    const count = countMap?.get(lookupKey) ?? 0;
    const entry = via === "library" ? lookup.byExerciseId.get(record.exerciseId) : lookup.byExerciseName.get(lookupKey);

    // The set carries its OWN occurrence id and it is not the matched
    // entry's (a set without one is given the entry's id by the analytics):
    // a retired occurrence (H2-5). Library-id / name matching is a fallback
    // only when ids are absent, never when they conflict, so the set keeps
    // its own identity (decision H5-49).
    if (record.programExerciseId && entry && record.programExerciseId !== entry.programExerciseId) {
      return record.programId
        ? { key: getRecordIdentityKey(record.programId, record.programExerciseId), reason: null }
        : { key: null, reason: "set names an occurrence that is not a current program exercise" };
    }

    if (count !== 1 || !entry) {
      return { key: null, reason: `legacy set matches ${count} program exercises by ${via === "library" ? "Library id" : "name"}` };
    }

    if (record.programId && entry.programId && record.programId !== entry.programId) {
      return { key: null, reason: "legacy set belongs to another program" };
    }

    return { key: getRecordIdentityKey(entry.programId, entry.programExerciseId), reason: null };
  }

  if (record.programId && record.programExerciseId) {
    return { key: getRecordIdentityKey(record.programId, record.programExerciseId), reason: null };
  }

  return { key: null, reason: "set carries no program identity" };
}

function sortSessionsAscending(sessions) {
  return (sessions ?? [])
    .map((session, index) => ({ session, index, time: getDateTime(session?.date) }))
    .sort((left, right) => left.time - right.time || right.index - left.index)
    .map((entry) => entry.session);
}

/**
 * computePersonalRecords({ sessions, programs, programExercises, exerciseLibrary, activeProgram, lookup }) ->
 *   {
 *     primary: { [programId::programExerciseId]: IdentityRecords },  // scope "program"
 *     acrossPrograms: { [exerciseId::measurement::weightMode]: IdentityRecords }, // scope "across programs"
 *     unattributed: [{ sessionId, date, setIndex, exerciseName, reason }],
 *   }
 * IdentityRecords = { identityKey, scope, programId, programExerciseId, exerciseId, name,
 *   measurement, weightMode, unit, sessionCount,
 *   records: { best_e1rm, best_weight, best_reps_at_weight: { [weight|"BW"]: Record },
 *              best_session_volume, best_time, best_distance },
 *   ineligibleSets: [{ type, sessionId, date, setIndex, reps, weight, rpe, reason }] }
 * Record = { type, value, unit, sessionId, date, setIndex, weight, rpe, reps|seconds|meters,
 *   eligible: true, scope, identityKey, programId, programExerciseId, exerciseId,
 *   exerciseName, measurement, weightMode, perSide, loadType,
 *   previousValue }  // the comparable value this record replaced, null for a first value (H5-50)
 *
 * A primary identity keeps the measurement + weight mode of its most recent
 * completed set; earlier sets logged under another mode are listed under
 * ineligibleSets ("weight mode changed") and never compared.
 */
export function computePersonalRecords({
  sessions = [],
  programs = [],
  programExercises = [],
  exerciseLibrary = [],
  activeProgram = null,
  lookup = null,
} = {}) {
  const resolvedLookup = lookup ?? buildRecordsLookup({ programs, programExercises, exerciseLibrary, activeProgram });
  const ordered = sortSessionsAscending(sessions);
  const primary = {};
  const acrossPrograms = {};
  const unattributed = [];
  const latestProfile = new Map();
  const perSession = [];

  ordered.forEach((session) => {
    const records = getSessionSetRecords(session, resolvedLookup).filter((record) => record.completed);
    const grouped = new Map();

    records.forEach((record) => {
      const attribution = attributeRecordIdentity(record, resolvedLookup);
      if (attribution.key) {
        const group = grouped.get(attribution.key) ?? [];
        group.push(record);
        grouped.set(attribution.key, group);
        latestProfile.set(attribution.key, getRecordProfile(record));
      } else {
        unattributed.push({
          sessionId: record.sessionId ?? null,
          date: record.date ?? null,
          setIndex: record.setNumber ?? null,
          exerciseName: record.exerciseName ?? "Exercise",
          reason: attribution.reason,
        });
      }
    });

    perSession.push({ session, records, grouped });
  });

  perSession.forEach(({ records, grouped }) => {
    grouped.forEach((group, key) => {
      const profile = latestProfile.get(key);
      const first = group[0];
      const identity =
        primary[key] ??
        (primary[key] = createIdentity({
          identityKey: key,
          scope: RECORD_SCOPES.program,
          programId: first.programId,
          programExerciseId: first.programExerciseId,
          exerciseId: first.exerciseId,
          name: first.exerciseName,
          measurement: profile.measurement,
          weightMode: profile.weightMode,
          perSide: profile.perSide,
          loadType: profile.loadType,
        }));
      const comparable = group.filter((record) => {
        const sameProfile = sameRecordProfile(record, profile);
        if (!sameProfile) {
          identity.ineligibleSets.push({
            type: "all",
            sessionId: record.sessionId ?? null,
            date: record.date ?? null,
            setIndex: record.setNumber ?? null,
            reps: record.reps,
            weight: record.weight,
            rpe: Number.isFinite(record.rpe) ? record.rpe : null,
            reason: `${describeRecordProfile(record)}: measurement or weight mode changed since (now ${describeRecordProfile(profile)}), not comparable`,
          });
        }
        return sameProfile;
      });

      comparable.forEach((record) => considerSet(identity, record));
      if (comparable.length) {
        considerSessionVolume(identity, null, comparable);
      }
    });

    // Secondary roll-up by Library id, per measurement + weight mode.
    const rollupGroups = new Map();
    records.forEach((record) => {
      if (!record.exerciseId) {
        return;
      }
      const key = getRecordRollupKey(record.exerciseId, record.measurement ?? "reps", record.weightMode ?? "kg", getRecordProfile(record));
      const group = rollupGroups.get(key) ?? [];
      group.push(record);
      rollupGroups.set(key, group);
    });

    rollupGroups.forEach((group, key) => {
      const first = group[0];
      const identity =
        acrossPrograms[key] ??
        (acrossPrograms[key] = createIdentity({
          identityKey: key,
          scope: RECORD_SCOPES.acrossPrograms,
          programId: null,
          programExerciseId: null,
          exerciseId: first.exerciseId,
          name: resolvedLookup.libraryById.get(first.exerciseId)?.name ?? first.exerciseName,
          ...getRecordProfile(first),
        }));
      group.forEach((record) => considerSet(identity, record));
      considerSessionVolume(identity, null, group);
    });
  });

  return { primary, acrossPrograms, unattributed };
}

function compareRecord(previous, candidate) {
  if (!previous) {
    return "first";
  }
  // Timed / distance records rank by load first, then by the count (the
  // same order considerSet keeps), so 60 s at 10 kg beats 70 s at BW and a
  // longer hold at a lighter load is never announced as new (H5 fix round 1).
  if (candidate.type === "best_time" || candidate.type === "best_distance") {
    const candidateRank = weightRank(candidate.weight);
    const previousRank = weightRank(previous.weight);
    if (candidateRank > previousRank) {
      return "new";
    }
    if (candidateRank < previousRank) {
      return null;
    }
  }
  if (candidate.value > previous.value) {
    return "new";
  }
  if (candidate.value === previous.value) {
    return "tied";
  }
  return null;
}

/**
 * The records of an identity are a previous reference only under the same
 * measurement, weight mode, per-side flag and load type (H5-41, H5-48):
 * after a kg -> per dumbbell or a two-sided -> per side change the first
 * session starts over ("first"), it never "beats" the old record.
 */
function comparableIdentity(previousIdentity, identity) {
  if (!previousIdentity) {
    return null;
  }
  return sameRecordProfile(previousIdentity, identity) ? previousIdentity : null;
}

function listRecords(identity) {
  const out = [];
  PERSONAL_RECORD_TYPES.forEach((type) => {
    const record = identity?.records?.[type];
    if (!record) {
      return;
    }
    if (type === "best_reps_at_weight") {
      Object.values(record).forEach((entry) => out.push(entry));
      return;
    }
    out.push(record);
  });
  return out;
}

function findPrevious(previousIdentity, record) {
  if (!previousIdentity) {
    return null;
  }
  if (record.type === "best_reps_at_weight") {
    return previousIdentity.records?.best_reps_at_weight?.[record.weightKey] ?? null;
  }
  return previousIdentity.records?.[record.type] ?? null;
}

/**
 * detectNewRecords(previousRecords, session, context) -> Array<Record & {
 *   status: "first" | "new" | "tied", previousValue, previousDate, acrossPrograms }>
 *
 * previousRecords: computePersonalRecords over the sessions BEFORE this one
 * (a record of the same session id is ignored). context: { programs,
 * programExercises, exerciseLibrary, activeProgram, lookup }. Only the
 * primary identity decides; `acrossPrograms` says whether the same set also
 * tops the Library-wide roll-up. A record whose identity had no record yet
 * has status "first" (a baseline, not an improvement).
 */
export function detectNewRecords(previousRecords, session, context = {}) {
  if (!session) {
    return [];
  }

  const current = computePersonalRecords({ ...context, sessions: [session] });
  const results = [];

  Object.values(current.primary).forEach((identity) => {
    const previousIdentity = comparableIdentity(previousRecords?.primary?.[identity.identityKey] ?? null, identity);
    // Did this identity hold any record before this session? A "first" record
    // of a known identity (a new weight key, a first timed set) is then a
    // plain new record, not the first log of the exercise.
    const identityHadRecords = Boolean(previousIdentity) && listRecords(previousIdentity).some((record) => record.sessionId !== session.id);

    listRecords(identity).forEach((record) => {
      let previous = findPrevious(previousIdentity, record);
      if (previous && previous.sessionId === session.id) {
        previous = null;
      }
      const status = compareRecord(previous, record);
      if (!status) {
        return;
      }

      const rollupKey = record.exerciseId
        ? getRecordRollupKey(record.exerciseId, record.measurement, record.weightMode, getRecordProfile(record))
        : null;
      const rollupPrevious = rollupKey
        ? findPrevious(previousRecords?.acrossPrograms?.[rollupKey] ?? null, record)
        : null;
      const rollupStatus =
        rollupKey && !(rollupPrevious && rollupPrevious.sessionId === session.id)
          ? compareRecord(rollupPrevious, record)
          : null;

      results.push({
        ...record,
        status,
        previousValue: previous?.value ?? null,
        previousDate: previous?.date ?? null,
        identityHadRecords,
        // The same set also beats the Library-wide roll-up ("across programs").
        acrossPrograms: rollupStatus === "new",
        acrossProgramsStatus: rollupStatus,
      });
    });
  });

  return results;
}

/**
 * listIneligibleSets(session, context) -> [{ exerciseName, identityKey, type,
 *   sessionId, date, setIndex, reps, weight, rpe, reason }]
 * The sets of this session that are not record candidates and why, so the
 * UI can explain ("12 reps: e1RM only for 1-10 reps").
 */
export function listIneligibleSets(session, context = {}) {
  if (!session) {
    return [];
  }

  const current = computePersonalRecords({ ...context, sessions: [session] });

  return Object.values(current.primary).flatMap((identity) =>
    identity.ineligibleSets.map((entry) => ({
      exerciseName: identity.name,
      identityKey: identity.identityKey,
      ...entry,
    })),
  );
}
