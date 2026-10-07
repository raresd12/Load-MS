// Shared helper for the visual-refresh fixtures (decision HV-5). Not imported
// by the app. Pure functions: colour parsing, alpha compositing, WCAG 2.x
// relative luminance and contrast ratio, plus the small CSS readers the
// fixtures need (comments stripped, balanced blocks, the Tailwind @theme
// tokens).

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*([^)]*)\)$/i;

function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function parseChannel(text) {
  const value = text.trim();
  if (/^-?\d*\.?\d+%$/.test(value)) {
    return clampByte((Number.parseFloat(value) / 100) * 255);
  }
  if (/^-?\d*\.?\d+$/.test(value)) {
    return clampByte(Number.parseFloat(value));
  }
  return null;
}

function parseAlpha(text) {
  const value = text.trim();
  if (/^-?\d*\.?\d+%$/.test(value)) {
    return clampUnit(Number.parseFloat(value) / 100);
  }
  if (/^-?\d*\.?\d+$/.test(value)) {
    return clampUnit(Number.parseFloat(value));
  }
  return null;
}

/**
 * parseColor(text) -> { r, g, b, a } | null
 * r, g, b in 0..255 (may be fractional), a in 0..1. Accepts #rgb, #rgba,
 * #rrggbb, #rrggbbaa, rgb() / rgba() with commas or the space syntax with an
 * optional "/ alpha". Anything else (var(), color-mix(), names) is null.
 */
export function parseColor(text) {
  if (typeof text !== "string") {
    return null;
  }
  const value = text.trim().toLowerCase();
  const hex = HEX.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) {
      digits = [...digits].map((digit) => digit + digit).join("");
    }
    const r = Number.parseInt(digits.slice(0, 2), 16);
    const g = Number.parseInt(digits.slice(2, 4), 16);
    const b = Number.parseInt(digits.slice(4, 6), 16);
    const a = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  const func = FUNC.exec(value);
  if (!func) {
    return null;
  }
  let parts;
  let alphaText = null;
  if (func[1].includes(",")) {
    parts = func[1].split(",");
    if (parts.length === 4) {
      alphaText = parts.pop();
    }
  } else {
    const [channels, alpha] = func[1].split("/");
    parts = channels.trim().split(/\s+/);
    alphaText = alpha ?? null;
  }
  if (parts.length !== 3) {
    return null;
  }
  const [r, g, b] = parts.map(parseChannel);
  const a = alphaText === null ? 1 : parseAlpha(alphaText);
  if ([r, g, b, a].some((channel) => channel === null || Number.isNaN(channel))) {
    return null;
  }
  return { r, g, b, a };
}

/**
 * composite(fg, bg) -> { r, g, b, a: 1 }
 * Source-over compositing of fg on an opaque bg (a bg with alpha < 1 is
 * treated as opaque: callers composite layers bottom-up).
 */
export function composite(fg, bg) {
  const alpha = fg.a ?? 1;
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
    a: 1,
  };
}

function linearise(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** relativeLuminance({ r, g, b }) -> number in 0..1 (WCAG 2.x, sRGB). */
export function relativeLuminance({ r, g, b }) {
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/**
 * contrastRatio(fg, bg) -> number in 1..21
 * fg and bg are colour objects or strings parseColor accepts. A translucent
 * fg is composited over bg first; bg is taken as opaque.
 */
export function contrastRatio(fg, bg) {
  const back = typeof bg === "string" ? parseColor(bg) : bg;
  const frontRaw = typeof fg === "string" ? parseColor(fg) : fg;
  if (!back || !frontRaw) {
    throw new Error(`contrastRatio: unparsable colour (${JSON.stringify(fg)} on ${JSON.stringify(bg)})`);
  }
  const front = (frontRaw.a ?? 1) < 1 ? composite(frontRaw, back) : frontRaw;
  const l1 = relativeLuminance(front);
  const l2 = relativeLuminance(back);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** colorsEqual(a, b) -> boolean: same channels (to 1e-6) and alpha (to 1e-6). */
export function colorsEqual(a, b) {
  const left = typeof a === "string" ? parseColor(a) : a;
  const right = typeof b === "string" ? parseColor(b) : b;
  if (!left || !right) {
    return false;
  }
  return ["r", "g", "b", "a"].every((key) => Math.abs(left[key] - right[key]) < 1e-6);
}

/** stripCssComments(css) -> css without block comments (offsets not kept). */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * readBlock(css, openIndex) -> { body, end } | null
 * openIndex points at a "{"; body is the text between it and its matching
 * "}", end the index just after that "}".
 */
export function readBlock(css, openIndex) {
  if (css[openIndex] !== "{") {
    return null;
  }
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
    } else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { body: css.slice(openIndex + 1, index), end: index + 1 };
      }
    }
  }
  return null;
}

/**
 * readThemeTokens(css) -> { found, body, tokens: Map<string, string> }
 * Reads every Tailwind `@theme` block (any modifier such as `inline`) and
 * returns its custom properties, name with the leading "--", value trimmed
 * with whitespace collapsed.
 */
export function readThemeTokens(css) {
  const clean = stripCssComments(css);
  const tokens = new Map();
  const bodies = [];
  for (const match of clean.matchAll(/@theme\b[^{;]*\{/g)) {
    const block = readBlock(clean, match.index + match[0].length - 1);
    if (!block) {
      continue;
    }
    bodies.push(block.body);
    for (const declaration of block.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    }
  }
  return { found: bodies.length > 0, body: bodies.join("\n"), tokens };
}

/**
 * readRules(css) -> Array<{ selector, body, atRule }>
 * Flat list of style rules (comments stripped). Rules nested in an at-rule
 * carry that at-rule's prelude in `atRule` (null at top level). @theme,
 * @keyframes and @font-face bodies are not split into rules.
 */
export function readRules(css, atRule = null) {
  const clean = stripCssComments(css);
  const rules = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf("{", cursor);
    if (open === -1) {
      break;
    }
    const prelude = clean.slice(cursor, open).replace(/^[\s\S]*;/, "").trim();
    const block = readBlock(clean, open);
    if (!block) {
      break;
    }
    if (prelude.startsWith("@")) {
      if (/^@(media|supports|layer|container)\b/.test(prelude)) {
        rules.push(...readRules(block.body, prelude));
      }
    } else if (prelude) {
      rules.push({ selector: prelude.replace(/\s+/g, " "), body: block.body, atRule });
    }
    cursor = block.end;
  }
  return rules;
}
