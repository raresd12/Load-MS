// Comparable readiness/performance ranking (review finding F7).
//
// The "best performance day" card used to rank sessions by whichever number a
// session happened to have (e1RM kg, volume kg, total reps or set counts) as
// if they were the same unit. This module ranks within ONE metric type only:
// e1RM across the sessions that report it, otherwise total volume. Reps and
// set counts are never ranked against kg values. Fewer than two comparable
// sessions is reported as `comparable: false` so the UI can say "Not enough
// comparable data" instead of naming a winner.

export const PERFORMANCE_METRICS = Object.freeze([
  Object.freeze({
    id: "e1rm",
    label: "Best e1RM",
    unit: "kg",
    getValue: (session) => session?.bestEstimatedStrength,
  }),
  Object.freeze({
    id: "volume",
    label: "Volume",
    unit: "kg",
    getValue: (session) => session?.totalVolume,
  }),
  // Phase H5 (decision H5-10): timed and distance programs report no kg
  // metric, so their sessions are ranked within total seconds / meters.
  // Seconds are never ranked against kg or meters.
  Object.freeze({
    id: "time",
    label: "Total time",
    unit: "s",
    getValue: (session) => session?.totalSeconds,
  }),
  Object.freeze({
    id: "distance",
    label: "Total distance",
    unit: "m",
    getValue: (session) => session?.totalMeters,
  }),
]);

export const MIN_COMPARABLE_SESSIONS = 2;

/**
 * getComparableSessionRequirement(sessions, options) ->
 *   { comparable, metricId, rankedCount, needed, minSessions }
 *
 * The exact sample the comparison still needs (H5-10): the metric closest to
 * the requirement, how many sessions carry it and how many more are needed
 * ("Not comparable yet: N more sessions needed"). `needed` is 0 when one
 * metric already has `minSessions` sessions.
 */
export function getComparableSessionRequirement(
  sessions,
  { metrics = PERFORMANCE_METRICS, minSessions = MIN_COMPARABLE_SESSIONS } = {},
) {
  let best = { metricId: null, rankedCount: 0 };

  for (const metric of metrics) {
    const rankedCount = rankSessionsByMetric(sessions, metric).length;

    if (rankedCount >= minSessions) {
      return { comparable: true, metricId: metric.id, rankedCount, needed: 0, minSessions };
    }

    if (rankedCount > best.rankedCount) {
      best = { metricId: metric.id, rankedCount };
    }
  }

  return {
    comparable: false,
    metricId: best.metricId,
    rankedCount: best.rankedCount,
    needed: Math.max(0, minSessions - best.rankedCount),
    minSessions,
  };
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * rankSessionsByMetric(sessions, metric) -> Array<{ session, value }> sorted
 * descending by that metric only; sessions without a positive numeric value
 * for the metric are left out (never treated as zero).
 */
export function rankSessionsByMetric(sessions, metric) {
  return (sessions ?? [])
    .map((session) => {
      const value = metric.getValue(session);
      return isPositiveNumber(value) ? { session, value } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.value - left.value);
}

/**
 * getBestComparablePerformance(sessions, options) ->
 *   { comparable: true, metricId, metricLabel, unit, session, value, rankedCount }
 *   | { comparable: false, metricId: null, metricLabel: null, unit: null,
 *       session: null, value: null, rankedCount: 0 }
 *
 * Tries each metric in order (e1RM first, then volume) and returns the top
 * session of the first metric that has at least `minSessions` (default 2)
 * comparable sessions. Sessions are only ever compared against sessions that
 * carry the same metric.
 */
export function getBestComparablePerformance(
  sessions,
  { metrics = PERFORMANCE_METRICS, minSessions = MIN_COMPARABLE_SESSIONS } = {},
) {
  for (const metric of metrics) {
    const ranked = rankSessionsByMetric(sessions, metric);

    if (ranked.length < minSessions) {
      continue;
    }

    return {
      comparable: true,
      metricId: metric.id,
      metricLabel: metric.label,
      unit: metric.unit,
      session: ranked[0].session,
      value: ranked[0].value,
      rankedCount: ranked.length,
    };
  }

  return {
    comparable: false,
    metricId: null,
    metricLabel: null,
    unit: null,
    session: null,
    value: null,
    rankedCount: 0,
  };
}
