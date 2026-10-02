// H1 Track C: comparable readiness/performance ranking (review finding F7).
// The "best performance day" must rank within one metric type only (e1RM
// across sessions that have it, else volume) and must report "not enough
// comparable data" instead of a winner when fewer than 2 sessions share a metric.
//
// Reproduction of the old defect: a session with only 200 total reps was ranked
// above a session with a 100 kg e1RM because raw numbers were compared as if
// they were the same unit.

import assert from "node:assert/strict";
import {
  getBestComparablePerformance,
  getComparableSessionRequirement,
  MIN_COMPARABLE_SESSIONS,
  PERFORMANCE_METRICS,
  rankSessionsByMetric,
} from "../src/lib/readinessPerformance.js";

const e1rm100 = { id: "a", date: "2026-09-01", bestEstimatedStrength: 100, totalVolume: 3000 };
const e1rm90 = { id: "b", date: "2026-09-03", bestEstimatedStrength: 90, totalVolume: 5000 };
const repsOnly = { id: "c", date: "2026-09-05", totalReps: 200, completedSetCount: 12 };
const volumeOnly = { id: "d", date: "2026-09-07", totalVolume: 9000 };
const setsOnly = { id: "e", date: "2026-09-08", completedSetCount: 40 };

assert.equal(MIN_COMPARABLE_SESSIONS, 2);
// H5 (decision H5-10): timed and distance totals are rankable too, after the
// kg metrics; the pre-H5 expectation ["e1rm", "volume"] is extended, not weakened.
assert.deepEqual(
  PERFORMANCE_METRICS.map((metric) => metric.id),
  ["e1rm", "volume", "time", "distance"],
  "kg metrics first (e1RM, then volume), then seconds, then meters; reps / sets never rank",
);
assert.deepEqual(
  PERFORMANCE_METRICS.map((metric) => metric.unit),
  ["kg", "kg", "s", "m"],
);

// --- H5: timed / distance programs rank within their own unit -------------
{
  const timed1 = { id: "t1", date: "2026-09-10", totalSeconds: 180 };
  const timed2 = { id: "t2", date: "2026-09-12", totalSeconds: 240 };
  const distance1 = { id: "d1", date: "2026-09-14", totalMeters: 4000 };
  const result = getBestComparablePerformance([timed1, distance1, timed2, repsOnly]);
  assert.equal(result.comparable, true);
  assert.equal(result.metricId, "time");
  assert.equal(result.unit, "s");
  assert.equal(result.session.id, "t2", "240 s beats 180 s; 4000 m is another unit");
  assert.equal(result.rankedCount, 2);

  const kgWins = getBestComparablePerformance([timed1, timed2, e1rm100, e1rm90]);
  assert.equal(kgWins.metricId, "e1rm", "kg metrics keep precedence over seconds");

  const distanceOnly = getBestComparablePerformance([distance1, { id: "d2", date: "2026-09-15", totalMeters: 5000 }]);
  assert.equal(distanceOnly.metricId, "distance");
  assert.equal(distanceOnly.session.id, "d2");
  assert.equal(distanceOnly.unit, "m");

  const oneTimed = getBestComparablePerformance([timed1, distance1]);
  assert.equal(oneTimed.comparable, false, "one timed + one distance session share no metric");
}

// --- H5: the exact sample requirement ("N more sessions needed") ----------
{
  const met = getComparableSessionRequirement([e1rm100, e1rm90]);
  assert.deepEqual(met, { comparable: true, metricId: "e1rm", rankedCount: 2, needed: 0, minSessions: 2 });

  const oneShort = getComparableSessionRequirement([e1rm100, repsOnly]);
  assert.deepEqual(oneShort, { comparable: false, metricId: "e1rm", rankedCount: 1, needed: 1, minSessions: 2 });

  const none = getComparableSessionRequirement([repsOnly, setsOnly]);
  assert.deepEqual(none, { comparable: false, metricId: null, rankedCount: 0, needed: 2, minSessions: 2 });

  assert.deepEqual(getComparableSessionRequirement([], { minSessions: 3 }), { comparable: false, metricId: null, rankedCount: 0, needed: 3, minSessions: 3 });
  assert.equal(getComparableSessionRequirement(undefined).needed, 2);

  // The metric closest to the requirement is named, whatever its order.
  const closest = getComparableSessionRequirement([e1rm100, volumeOnly, { id: "v2", totalVolume: 100 }], { minSessions: 4 });
  assert.equal(closest.metricId, "volume", "volume has 3 sessions (a, d, v2), e1RM only 1");
  assert.equal(closest.needed, 1);
}

// --- F7 reproduction: reps / sets never beat kg values ---------------------
{
  const result = getBestComparablePerformance([e1rm100, repsOnly, setsOnly, e1rm90]);
  assert.equal(result.comparable, true);
  assert.equal(result.metricId, "e1rm");
  assert.equal(result.session.id, "a", "100 kg e1RM wins; 200 reps / 40 sets are not comparable units");
  assert.equal(result.value, 100);
  assert.equal(result.rankedCount, 2, "only the two e1RM sessions were ranked");
}

// --- e1RM is preferred even when a volume-only session has a bigger number --
{
  const result = getBestComparablePerformance([e1rm90, volumeOnly, e1rm100]);
  assert.equal(result.metricId, "e1rm");
  assert.equal(result.session.id, "a");
}

// --- fall back to volume when fewer than 2 sessions carry e1RM ------------
{
  const result = getBestComparablePerformance([e1rm100, volumeOnly, repsOnly]);
  assert.equal(result.metricId, "volume", "one e1RM session is not comparable; volume has two");
  assert.equal(result.session.id, "d", "9000 kg volume beats 3000 kg volume");
  assert.equal(result.rankedCount, 2);
}

// --- not enough comparable data -------------------------------------------
{
  const single = getBestComparablePerformance([e1rm100]);
  assert.equal(single.comparable, false, "a single session has nothing to compare against");
  assert.equal(single.session, null);
  assert.equal(single.metricId, null);

  const mixed = getBestComparablePerformance([e1rm100, repsOnly, setsOnly]);
  assert.equal(mixed.comparable, false, "e1RM x1 + reps + sets: no metric has two sessions");

  const empty = getBestComparablePerformance([]);
  assert.equal(empty.comparable, false);
  assert.equal(getBestComparablePerformance(undefined).comparable, false);
}

// --- ranking ignores non-numeric / zero / null values ---------------------
{
  const ranked = rankSessionsByMetric(
    [
      { id: "z", bestEstimatedStrength: 0 },
      { id: "n", bestEstimatedStrength: null },
      { id: "s", bestEstimatedStrength: "120" },
      { id: "ok", bestEstimatedStrength: 80 },
      { id: "nan", bestEstimatedStrength: Number.NaN },
      { id: "top", bestEstimatedStrength: 95.5 },
    ],
    PERFORMANCE_METRICS[0],
  );
  assert.deepEqual(
    ranked.map((entry) => entry.session.id),
    ["top", "ok"],
    "zero, null, string and NaN values are excluded, never treated as 0",
  );
}

// --- minSessions option ------------------------------------------------------
{
  const result = getBestComparablePerformance([e1rm100], { minSessions: 1 });
  assert.equal(result.comparable, true);
  assert.equal(result.session.id, "a");
}

console.log("verify-readiness-performance: all assertions passed");
