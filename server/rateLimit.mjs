// In-memory sliding-window rate limits (decision H6-12). Each key keeps the
// times of its accepted hits inside the longest window; a refused hit is not
// recorded, so a client that waits gets back in. Memory stays bounded: idle
// keys are swept, and the map never holds more than maxKeys entries.

export function createRateLimiter({ clock = () => Date.now(), maxKeys = 20000 } = {}) {
  const hits = new Map();
  let lastSweep = 0;

  function sweep(now) {
    for (const [key, entry] of hits) {
      if (!entry.times.length || now - entry.times[entry.times.length - 1] >= entry.horizon) {
        hits.delete(key);
      }
    }

    lastSweep = now;

    // Still too many keys: drop the oldest-inserted ones.
    while (hits.size > maxKeys) {
      hits.delete(hits.keys().next().value);
    }
  }

  /**
   * rules: [{ windowMs, max }]. Returns { ok: true } and records the hit, or
   * { ok: false, retryAfterSeconds } without recording it. check() answers
   * the same question without recording anything (decision H6-29: a request
   * refused by one bucket never uses up another).
   */
  function hit(key, rules) {
    return evaluate(key, rules, true);
  }

  function check(key, rules) {
    return evaluate(key, rules, false);
  }

  function evaluate(key, rules, record) {
    const now = clock();
    const horizon = Math.max(...rules.map((rule) => rule.windowMs));

    if (now - lastSweep >= 60_000 || hits.size > maxKeys) {
      sweep(now);
    }

    let entry = hits.get(key);

    if (!entry) {
      if (!record) {
        return { ok: true };
      }

      entry = { times: [], horizon };
      hits.set(key, entry);
    }

    entry.horizon = Math.max(entry.horizon, horizon);

    while (entry.times.length && now - entry.times[0] >= entry.horizon) {
      entry.times.shift();
    }

    let retryAfterMs = 0;

    for (const rule of rules) {
      const inWindow = entry.times.filter((time) => now - time < rule.windowMs);

      if (inWindow.length >= rule.max) {
        retryAfterMs = Math.max(retryAfterMs, inWindow[inWindow.length - rule.max] + rule.windowMs - now);
      }
    }

    if (retryAfterMs > 0) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    if (record) {
      entry.times.push(now);
    }

    return { ok: true };
  }

  return { hit, check, size: () => hits.size };
}
