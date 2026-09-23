// Rest normalization (review finding F6, decision 19.4-3).
//
// Stored rest can be a scalar number of seconds, a [min, max] range, or (from
// older data / free text) a numeric string such as "90" or "150-180". Every
// consumer that needs one number (the rest timer, plan strips, the target
// editor) goes through resolveRestSeconds so the rule "a range starts the
// timer at max" lives in exactly one place. Stored ranges are never rewritten.

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRangeText(text) {
  const match = String(text ?? "")
    .trim()
    .replace(/[–—]/g, "-")
    .match(/^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)$/i);

  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2])];
}

function emptyResolution() {
  return { seconds: 0, min: null, max: null, isRange: false, label: "" };
}

/**
 * resolveRestSeconds(rest) -> { seconds, min, max, isRange, label }
 *
 * - number            -> seconds = number, min = max = number, isRange false
 * - [min, max]        -> seconds = max (decision 19.4-3), isRange true when min !== max
 * - "90" / "150-180"  -> parsed like the number / array forms
 * - anything else     -> seconds 0, min/max null, isRange false, label ""
 *
 * Non-positive values resolve to seconds 0 so a timer never starts for them.
 * `label` is a clock label ("3:00" or "2:30-3:00").
 */
export function resolveRestSeconds(rest) {
  let min = null;
  let max = null;

  if (Array.isArray(rest)) {
    const values = rest.map(toFiniteNumber).filter((value) => value !== null);

    if (!values.length) {
      return emptyResolution();
    }

    min = Math.min(...values);
    max = Math.max(...values);
  } else if (typeof rest === "string") {
    const range = parseRangeText(rest);

    if (range) {
      min = Math.min(...range);
      max = Math.max(...range);
    } else {
      const scalar = toFiniteNumber(rest);

      if (scalar === null) {
        return emptyResolution();
      }

      min = scalar;
      max = scalar;
    }
  } else {
    const scalar = toFiniteNumber(rest);

    if (scalar === null) {
      return emptyResolution();
    }

    min = scalar;
    max = scalar;
  }

  if (max <= 0) {
    return emptyResolution();
  }

  min = Math.max(0, min);
  const isRange = min !== max;

  return {
    seconds: max,
    min,
    max,
    isRange,
    label: isRange ? `${formatRestClock(min)}-${formatRestClock(max)}` : formatRestClock(max),
  };
}

/**
 * "2:30" style clock label for a number of seconds (negative -> "0:00").
 */
export function formatRestClock(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(toFiniteNumber(totalSeconds) ?? 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Editor text for a stored rest value: "180" for a scalar, "150-180" for a
 * range, "" when nothing usable is stored. The stored value itself is untouched.
 */
export function formatRestEditorValue(rest) {
  const resolved = resolveRestSeconds(rest);

  if (!resolved.seconds) {
    return "";
  }

  return resolved.isRange ? `${resolved.min}-${resolved.max}` : String(resolved.max);
}

/**
 * Parses editor text back into a storable rest value.
 * "90" -> { valid: true, value: 90 }; "150-180" -> { valid: true, value: [150, 180] }.
 * Blank, zero, negative, inverted ranges and other text are invalid.
 */
export function parseRestEditorValue(text) {
  const cleanText = String(text ?? "").trim();

  if (!cleanText) {
    return { valid: false, value: null, error: "Rest must be seconds (e.g. 90) or a range like 150-180." };
  }

  const range = parseRangeText(cleanText);

  if (range) {
    const [min, max] = range;

    if (min <= 0 || max <= 0) {
      return { valid: false, value: null, error: "Rest seconds must be positive." };
    }

    if (max < min) {
      return { valid: false, value: null, error: "Rest range must be written as min-max (e.g. 150-180)." };
    }

    return { valid: true, value: min === max ? min : [min, max], error: null };
  }

  const scalar = toFiniteNumber(cleanText);

  if (scalar === null || scalar <= 0) {
    return { valid: false, value: null, error: "Rest must be seconds (e.g. 90) or a range like 150-180." };
  }

  return { valid: true, value: scalar, error: null };
}
