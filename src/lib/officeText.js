// DOCX / XLSX -> plain text (decision H3-2).
//
// The import assistant sends TEXT to the model for office documents, so the
// user can read exactly what leaves the device. Nothing here keeps the file:
// the functions take an ArrayBuffer, return the extracted text and counters,
// and never put bytes or base64 in what they return.
//
// fflate is loaded with a dynamic import() inside the async functions, so it
// lives in its own lazy chunk and never enters the startup chunks.
//
// Both extractors NEVER throw: a broken zip, a missing part, an encrypted file
// or a wrong kind returns { text: "", meta: { warnings: [reason] } }.

export const OFFICE_TEXT_DEFAULTS = Object.freeze({
  maxChars: 80000,
  maxSheets: 10,
  maxRows: 2000,
  maxColumns: 50,
  // Largest uncompressed XML part that is ever inflated (zip-bomb guard).
  maxPartBytes: 24 * 1024 * 1024,
  // Most uncompressed bytes ONE file may inflate over all its parts (H3-14).
  maxTotalBytes: 48 * 1024 * 1024,
  // Most XML tokens walked per file for the document / the sheets, and per
  // part for shared strings and styles: the work is bounded, not only the text.
  maxXmlTokens: 1000000,
});

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP_MAGIC = [0x50, 0x4b];

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// ---------------------------------------------------------------------------
// Small tolerant XML tokenizer (no DOMParser: it must run in Node fixtures).
// ---------------------------------------------------------------------------

export function decodeXmlEntities(value) {
  const text = String(value ?? "");

  if (!text.includes("&")) {
    return text;
  }

  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);

      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }

      return String.fromCodePoint(code);
    }

    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

/**
 * Yields { type: "open" | "close" | "text", name, attrs, selfClosing, text }.
 * Comments, processing instructions and DOCTYPE are skipped; CDATA is text.
 * A tag that never closes ends the walk instead of throwing.
 */
function* tokenizeXml(xml) {
  const length = xml.length;
  let index = 0;

  while (index < length) {
    const open = xml.indexOf("<", index);

    if (open < 0) {
      yield { type: "text", text: decodeXmlEntities(xml.slice(index)) };
      return;
    }

    if (open > index) {
      yield { type: "text", text: decodeXmlEntities(xml.slice(index, open)) };
    }

    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) return;
      index = end + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) {
        yield { type: "text", text: xml.slice(open + 9) };
        return;
      }
      yield { type: "text", text: xml.slice(open + 9, end) };
      index = end + 3;
      continue;
    }

    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) return;
      index = end + 2;
      continue;
    }

    // Find the closing ">" outside quoted attribute values.
    let cursor = open + 1;
    let quote = "";

    while (cursor < length) {
      const char = xml[cursor];

      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }

      cursor += 1;
    }

    if (cursor >= length) {
      return;
    }

    const body = xml.slice(open + 1, cursor);
    index = cursor + 1;

    if (body[0] === "!") {
      continue;
    }

    if (body[0] === "/") {
      yield { type: "close", name: body.slice(1).trim() };
      continue;
    }

    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^[^\s/]+/.exec(inner);

    if (!nameMatch) {
      continue;
    }

    const name = nameMatch[0];
    yield { type: "open", name, attrs: inner.slice(name.length), selfClosing };

    if (selfClosing) {
      yield { type: "close", name, selfClosing: true };
    }
  }
}

function isXmlSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Yields [name, rawValue] for every name="value" / name='value' pair of a
 * tag. One pass over the text, no regular expression: the attribute text is
 * untrusted and a run of 100,000 letters must cost 100,000 steps, not their
 * square (fix round 1).
 */
function* scanAttributes(attrs) {
  const text = String(attrs ?? "");
  const length = text.length;
  let index = 0;

  while (index < length) {
    while (index < length && isXmlSpace(text.charCodeAt(index))) index += 1;

    const nameStart = index;

    while (index < length && !isXmlSpace(text.charCodeAt(index)) && text[index] !== "=") index += 1;

    const name = text.slice(nameStart, index);

    while (index < length && isXmlSpace(text.charCodeAt(index))) index += 1;

    if (index >= length) {
      return;
    }

    if (text[index] !== "=") {
      // A name without a value; the next name starts here.
      continue;
    }

    index += 1;

    while (index < length && isXmlSpace(text.charCodeAt(index))) index += 1;

    const quote = text[index];

    if (quote !== '"' && quote !== "'") {
      continue;
    }

    const end = text.indexOf(quote, index + 1);

    if (end < 0) {
      return;
    }

    if (name) {
      yield [name, text.slice(index + 1, end)];
    }

    index = end + 1;
  }
}

function getAttribute(attrs, attributeName) {
  if (!attrs) {
    return null;
  }

  for (const [name, value] of scanAttributes(attrs)) {
    if (name === attributeName) {
      return decodeXmlEntities(value);
    }
  }

  return null;
}

function localName(name) {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/** The attribute whatever prefix its namespace was given ("w:val", "ns0:val", "val"). */
function getAttributeByLocalName(attrs, attributeLocalName) {
  if (!attrs) {
    return null;
  }

  for (const [name, value] of scanAttributes(attrs)) {
    if (!name.startsWith("xmlns") && localName(name) === attributeLocalName) {
      return decodeXmlEntities(value);
    }
  }

  return null;
}

function trimEndSpacesAndTabs(text) {
  let end = text.length;

  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end -= 1;

  return end === text.length ? text : text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (input && input.buffer instanceof ArrayBuffer && typeof input.byteLength === "number") {
    return new Uint8Array(input.buffer, input.byteOffset ?? 0, input.byteLength);
  }

  return null;
}

function startsWithBytes(bytes, magic) {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

function decodeXmlBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);

    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }

    return new TextDecoder("utf-16le").decode(swapped);
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Tabs and newlines stay; every other control character goes.
function stripControlCharacters(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function singleLine(text) {
  // Split and trim, not one pattern with \s* on both sides of the line break:
  // that pattern is quadratic on a long run of spaces.
  return stripControlCharacters(String(text ?? ""))
    .split(/[\r\n]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "")
    .join(" ")
    .replace(/\t/g, " ")
    .trim();
}

// Trailing spaces removed, runs of blank lines collapsed, no blank edges.
function joinLines(lines) {
  const out = [];

  for (const raw of lines) {
    const line = trimEndSpacesAndTabs(stripControlCharacters(raw));

    if (line.trim() === "") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
    } else {
      out.push(line);
    }
  }

  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }

  return out.join("\n");
}

function limitText(text, maxChars, warnings) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  let cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");

  if (lastBreak > maxChars * 0.5) {
    cut = cut.slice(0, lastBreak);
  }

  warnings.push(
    `The document text is longer than ${maxChars.toLocaleString("en-US")} characters; only the first part was kept.`,
  );

  return { text: cut.trimEnd(), truncated: true };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function emptyResult(kind, reason) {
  const meta =
    kind === "docx"
      ? { kind, paragraphs: 0, rows: 0, truncated: false, warnings: [reason] }
      : { kind, sheets: 0, rows: 0, truncated: false, warnings: [reason] };

  return { text: "", meta };
}

function normalizePartName(name) {
  return String(name ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Zip container (fix round 1). The central directory is read here, not by
// fflate's unzipSync: that function trusts the entry count and the declared
// sizes of the file, so a forged 3 KB document could make it loop 2^32 times
// or inflate gigabytes. Here every number of the file is checked against the
// file itself, and a part is inflated as a stream that stops at its declared
// size. fflate only provides the inflate algorithm.
// ---------------------------------------------------------------------------

// A DOCX / XLSX has a few dozen parts, a few hundred with many images.
export const MAX_ZIP_ENTRIES = 5000;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_END_BYTES = 22;
const ZIP_CENTRAL_BYTES = 46;
const ZIP_LOCAL_BYTES = 30;
// Compressed bytes handed to the inflater at a time: the output is counted
// after every slice, so at most one slice is inflated past the limit.
const INFLATE_SLICE_BYTES = 16 * 1024;

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (readUint16(bytes, offset) | (readUint16(bytes, offset + 2) << 16)) >>> 0;
}

function readUint64(bytes, offset) {
  return readUint32(bytes, offset + 4) * 0x100000000 + readUint32(bytes, offset);
}

function zipError(reason) {
  return new Error(`zip: ${reason}`);
}

/**
 * The entries of the central directory:
 * [{ name, method, encrypted, compressedSize, originalSize, localOffset }].
 * Throws on anything that does not add up (no end record, more than
 * MAX_ZIP_ENTRIES entries, a count the directory has no room for, an entry
 * that runs past the file).
 */
function listZipEntries(bytes) {
  const length = bytes.length;
  let end = length - ZIP_END_BYTES;
  const lowest = Math.max(0, end - 0xffff);

  while (end >= lowest && readUint32(bytes, end) !== ZIP_END_SIGNATURE) end -= 1;

  if (end < lowest || end < 0) {
    throw zipError("no end record");
  }

  let count = readUint16(bytes, end + 10);
  let directorySize = readUint32(bytes, end + 12);
  let directoryOffset = readUint32(bytes, end + 16);

  // Zip64: the locator sits right in front of the end record.
  const locator = end - 20;

  if (locator >= 0 && readUint32(bytes, locator) === ZIP64_LOCATOR_SIGNATURE) {
    const end64 = readUint64(bytes, locator + 8);

    if (end64 + 56 <= length && readUint32(bytes, end64) === ZIP64_END_SIGNATURE) {
      count = readUint64(bytes, end64 + 32);
      directorySize = readUint64(bytes, end64 + 40);
      directoryOffset = readUint64(bytes, end64 + 48);
    }
  }

  if (count > MAX_ZIP_ENTRIES) {
    throw zipError("too many entries");
  }

  if (
    directoryOffset > length ||
    directorySize > length - directoryOffset ||
    count * ZIP_CENTRAL_BYTES > length - directoryOffset
  ) {
    throw zipError("directory does not fit the file");
  }

  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let cursor = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (cursor + ZIP_CENTRAL_BYTES > length || readUint32(bytes, cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw zipError("broken directory entry");
    }

    const flags = readUint16(bytes, cursor + 8);
    const method = readUint16(bytes, cursor + 10);
    let compressedSize = readUint32(bytes, cursor + 20);
    let originalSize = readUint32(bytes, cursor + 24);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    let localOffset = readUint32(bytes, cursor + 42);
    const nameStart = cursor + ZIP_CENTRAL_BYTES;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;

    if (next > length) {
      throw zipError("directory entry runs past the file");
    }

    // Zip64 extra field: the 8-byte values of the fields that are 0xffffffff.
    let extra = extraStart;

    while (extra + 4 <= extraStart + extraLength) {
      const id = readUint16(bytes, extra);
      const size = readUint16(bytes, extra + 2);
      let field = extra + 4;

      if (id === 0x0001) {
        if (originalSize === 0xffffffff && field + 8 <= extra + 4 + size) {
          originalSize = readUint64(bytes, field);
          field += 8;
        }

        if (compressedSize === 0xffffffff && field + 8 <= extra + 4 + size) {
          compressedSize = readUint64(bytes, field);
          field += 8;
        }

        if (localOffset === 0xffffffff && field + 8 <= extra + 4 + size) {
          localOffset = readUint64(bytes, field);
        }
      }

      extra += 4 + size;
    }

    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, extraStart)),
      method,
      encrypted: (flags & 1) === 1,
      compressedSize,
      originalSize,
      localOffset,
    });
    cursor = next;
  }

  return entries;
}

/**
 * The bytes of one entry. Never produces more than entry.originalSize bytes:
 * a stream that holds more than it declares is refused, not cut.
 */
function inflateZipEntry(bytes, entry, Inflate) {
  const header = entry.localOffset;

  if (entry.encrypted) {
    throw zipError("encrypted entry");
  }

  if (header + ZIP_LOCAL_BYTES > bytes.length || readUint32(bytes, header) !== ZIP_LOCAL_SIGNATURE) {
    throw zipError("broken local header");
  }

  const start = header + ZIP_LOCAL_BYTES + readUint16(bytes, header + 26) + readUint16(bytes, header + 28);

  if (start + entry.compressedSize > bytes.length) {
    throw zipError("entry runs past the file");
  }

  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) {
    if (entry.compressedSize !== entry.originalSize) {
      throw zipError("stored entry with two sizes");
    }

    return data.slice();
  }

  if (entry.method !== 8) {
    throw zipError("unknown compression");
  }

  const out = new Uint8Array(entry.originalSize);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > out.length) {
      throw zipError("entry is larger than it declares");
    }

    out.set(chunk, written);
    written += chunk.length;
  });

  if (data.length === 0) {
    inflater.push(data, true);
  }

  for (let offset = 0; offset < data.length; offset += INFLATE_SLICE_BYTES) {
    const last = offset + INFLATE_SLICE_BYTES >= data.length;
    inflater.push(data.subarray(offset, offset + INFLATE_SLICE_BYTES), last);
  }

  if (written !== out.length) {
    throw zipError("entry is smaller than it declares");
  }

  return out;
}

/**
 * Opens the zip and inflates only the parts `wanted(name)` accepts, each at
 * most maxPartBytes uncompressed. Returns { parts: Map(lowercase name ->
 * Uint8Array), names: string[], oversized: string[] } or { error }.
 */
/**
 * Refuses a directory in which two entries share local data (fix round 2):
 * the overlapping-entry zip bomb lists one deflated stream under many names.
 * The range of an entry is at least its local header and its compressed
 * bytes; no writer produces entries that overlap.
 */
function assertNoOverlappingEntries(entries) {
  const ranges = entries
    .map((entry) => [entry.localOffset, entry.localOffset + ZIP_LOCAL_BYTES + entry.compressedSize])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) {
      throw zipError("entries overlap");
    }
  }
}

/** The inflate allowance of one file: every part read takes from it. */
function createInflateBudget() {
  return { left: OFFICE_TEXT_DEFAULTS.maxTotalBytes };
}

async function readZipParts(bytes, wanted, label, budget = createInflateBudget()) {
  if (!bytes || bytes.length === 0) {
    return { error: `The ${label} file is empty.` };
  }

  if (startsWithBytes(bytes, OLE_MAGIC)) {
    return {
      error: `This ${label} file is password-protected or saved in the legacy binary format. Remove the password or export as DOCX, XLSX, PDF or text.`,
    };
  }

  if (!startsWithBytes(bytes, ZIP_MAGIC)) {
    return {
      error: `This file is not a valid ${label} document (it is not a zip archive). Export as DOCX, XLSX, PDF or text.`,
    };
  }

  let Inflate;

  try {
    ({ Inflate } = await import("fflate"));
  } catch {
    return { error: `The ${label} reader could not be loaded. Check the connection and try again, or paste the text.` };
  }

  const names = [];
  const oversized = [];

  try {
    const parts = new Map();

    const entries = listZipEntries(bytes);
    assertNoOverlappingEntries(entries);

    for (const entry of entries) {
      const name = normalizePartName(entry.name);
      names.push(name);

      if (!wanted(name) || parts.has(name) || oversized.includes(name)) {
        continue;
      }

      // Too large on its own, or more than what is left for the whole file.
      if (entry.originalSize > OFFICE_TEXT_DEFAULTS.maxPartBytes || entry.originalSize > budget.left) {
        oversized.push(name);
        continue;
      }

      budget.left -= entry.originalSize;
      parts.set(name, inflateZipEntry(bytes, entry, Inflate));
    }

    return { parts, names, oversized };
  } catch {
    return {
      error: `The ${label} file is damaged or encrypted and could not be opened. Save it again or export as PDF or text.`,
    };
  }
}

function resolveTarget(baseDir, target) {
  const clean = String(target ?? "").replace(/\\/g, "/");

  if (clean.startsWith("/")) {
    return normalizePartName(clean);
  }

  const segments = `${baseDir}/${clean}`.split("/");
  const out = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }

  return normalizePartName(out.join("/"));
}

function readRelationships(xml) {
  const relations = [];

  for (const token of tokenizeXml(xml)) {
    if (token.type === "open" && localName(token.name) === "Relationship") {
      relations.push({
        id: getAttribute(token.attrs, "Id") ?? "",
        type: getAttribute(token.attrs, "Type") ?? "",
        target: getAttribute(token.attrs, "Target") ?? "",
        external: getAttribute(token.attrs, "TargetMode") === "External",
      });
    }
  }

  return relations;
}

function looksLikeXml(text) {
  return /^\s*</.test(text);
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

// Element names are compared by LOCAL name (fix round 1): the namespace of
// WordprocessingML may be bound to any prefix ("w:", "ns0:") or be the default
// one, as the XLSX walkers already assume.
const DOCX_SKIPPED_CONTAINERS = new Set(["drawing", "pict", "object"]);
const DOCX_IGNORED_TEXT_CONTAINERS = new Set(["del", "moveFrom"]);
const DOCX_MAIN_PART_PATTERN = /^word\/[^/]*document[^/]*\.xml$/;
const TOO_LARGE_TO_WALK_WARNING =
  "The document is too large to read in full; only the first part was read. Export only the program pages as PDF or text.";

function walkDocumentXml(xml, { maxChars, maxTokens }) {
  const lines = [];
  let tokensLeft = maxTokens;
  let charsLeft = maxChars * 2;
  let stopped = false;
  // One frame per open table: { rows: string[], cells: string[] | null, cell: string[] | null }
  const tables = [];
  let paragraph = "";
  let isHeading = false;
  let inText = false;
  let skipDepth = 0;
  let skipName = "";
  let ignoreDepth = 0;
  let drawings = 0;
  let paragraphs = 0;
  let rows = 0;

  const currentTable = () => tables[tables.length - 1] ?? null;

  function endParagraph() {
    const table = currentTable();
    const text = paragraph;
    const heading = isHeading;
    paragraph = "";
    isHeading = false;

    if (table && table.cell) {
      const cellText = singleLine(text);
      if (cellText) table.cell.push(cellText);
      return;
    }

    if (text.trim() !== "") {
      paragraphs += 1;
    }

    // Heading and title styles start a new block.
    if (heading) lines.push("");
    lines.push(text.replace(/\r\n?/g, "\n"));
  }

  for (const token of tokenizeXml(xml)) {
    tokensLeft -= 1;

    // Bounded work (fix round 2): a part of empty elements, or far more text
    // than is kept, is not walked to its end.
    if (tokensLeft < 0 || charsLeft < 0) {
      stopped = true;
      break;
    }

    if (skipDepth > 0) {
      if (token.type === "open" && token.name === skipName) skipDepth += 1;
      else if (token.type === "close" && token.name === skipName) skipDepth -= 1;
      continue;
    }

    if (token.type === "text") {
      if (inText && ignoreDepth === 0) {
        paragraph += token.text;
        charsLeft -= token.text.length;
      }
      continue;
    }

    const name = localName(token.name);

    if (token.type === "open") {
      if (name === "Fallback") {
        // Same content as mc:Choice, in the legacy VML form.
        skipDepth = 1;
        skipName = token.name;
        continue;
      }

      if (DOCX_SKIPPED_CONTAINERS.has(name)) {
        drawings += 1;
        skipDepth = 1;
        skipName = token.name;
        continue;
      }

      if (DOCX_IGNORED_TEXT_CONTAINERS.has(name)) {
        ignoreDepth += 1;
        continue;
      }

      switch (name) {
        case "t":
          inText = true;
          break;
        case "pStyle":
          if (/^(heading|title)/i.test(getAttributeByLocalName(token.attrs, "val") ?? "")) isHeading = true;
          break;
        case "tab":
          // w:tab inside w:tabs (paragraph properties) is a tab stop, not text.
          if (getAttributeByLocalName(token.attrs, "val") === null) paragraph += "\t";
          break;
        case "br":
        case "cr":
          paragraph += "\n";
          break;
        case "noBreakHyphen":
          paragraph += "-";
          break;
        case "tbl":
          tables.push({ rows: [], cells: null, cell: null });
          break;
        case "tr": {
          const table = currentTable();
          if (table) table.cells = [];
          break;
        }
        case "tc": {
          const table = currentTable();
          if (table) {
            if (!table.cells) table.cells = [];
            table.cell = [];
          }
          break;
        }
        default:
          break;
      }

      continue;
    }

    // close
    if (DOCX_IGNORED_TEXT_CONTAINERS.has(name)) {
      ignoreDepth = Math.max(0, ignoreDepth - 1);
      continue;
    }

    switch (name) {
      case "t":
        inText = false;
        break;
      case "p":
        endParagraph();
        break;
      case "tc": {
        const table = currentTable();
        if (table && table.cell) {
          if (paragraph) endParagraph();
          table.cells.push(table.cell.join(" "));
          table.cell = null;
        }
        break;
      }
      case "tr": {
        const table = currentTable();
        if (table && table.cells) {
          const cells = table.cells;
          while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
          if (cells.length > 0) table.rows.push(cells.join(" | "));
          table.cells = null;
        }
        break;
      }
      case "tbl": {
        const table = tables.pop();
        if (!table) break;
        const parent = currentTable();

        if (parent && parent.cell) {
          // Nested table: its rows become part of the outer cell.
          if (table.rows.length > 0) parent.cell.push(table.rows.join(" ; "));
        } else {
          rows += table.rows.length;
          // A blank line after the table only: a heading stays attached to it.
          lines.push(...table.rows, "");
        }
        break;
      }
      default:
        break;
    }
  }

  // Tolerate a document cut in the middle of a paragraph or table.
  while (tables.length > 0) {
    const table = tables.pop();
    if (table.cell && paragraph) {
      const cellText = singleLine(paragraph);
      paragraph = "";
      if (cellText) table.cell.push(cellText);
    }
    if (table.cell) table.cells.push(table.cell.join(" "));
    if (table.cells && table.cells.some((cell) => cell !== "")) table.rows.push(table.cells.join(" | "));
    rows += table.rows.length;
    lines.push(...table.rows, "");
  }

  if (paragraph.trim() !== "") {
    paragraphs += 1;
    lines.push(paragraph);
  }

  return { lines: lines.flatMap((line) => line.split("\n")), paragraphs, rows, drawings, stopped };
}

/**
 * extractDocxText(arrayBuffer, { maxChars }) ->
 *   { text, meta: { kind: "docx", paragraphs, rows, truncated, warnings } }
 * Paragraphs are lines, a table row is one line with cells joined by " | ".
 * Headers, footers, footnotes, comments, deleted (tracked) text and
 * drawings/images are not part of the text.
 */
export async function extractDocxText(arrayBuffer, options = {}) {
  try {
    const maxChars = positiveInteger(options?.maxChars, OFFICE_TEXT_DEFAULTS.maxChars);
    const bytes = toBytes(arrayBuffer);

    if (!bytes) {
      return emptyResult("docx", "The Word file could not be read.");
    }

    // Only the part that is read is inflated (fix round 2): the package
    // relationships first, then exactly one main document part.
    const budget = createInflateBudget();
    const index = await readZipParts(bytes, (name) => name === "_rels/.rels", "Word", budget);

    if (index.error) {
      return emptyResult("docx", index.error);
    }

    let partName = "word/document.xml";

    if (!index.names.includes(partName) && index.parts.has("_rels/.rels")) {
      const main = readRelationships(decodeXmlBytes(index.parts.get("_rels/.rels"))).find((relation) =>
        relation.type.endsWith("/officeDocument"),
      );

      if (main) {
        partName = resolveTarget("", main.target);
      }
    }

    const isMainPartName = DOCX_MAIN_PART_PATTERN.test(partName);
    const zip = isMainPartName
      ? await readZipParts(bytes, (name) => name === partName, "Word", budget)
      : { parts: new Map(), names: index.names, oversized: [] };

    if (zip.error) {
      return emptyResult("docx", zip.error);
    }

    if (!zip.parts.has(partName)) {
      if (zip.oversized.includes(partName)) {
        return emptyResult("docx", "The Word document is too large to read here. Export only the program pages as PDF or text.");
      }

      if (zip.names.includes("encryptedpackage") || zip.names.includes("encryptioninfo")) {
        return emptyResult("docx", "This Word file is password-protected. Remove the password or export as PDF or text.");
      }

      if (zip.names.includes("xl/workbook.xml")) {
        return emptyResult("docx", "This file is an Excel workbook, not a Word document. Rename it to .xlsx and try again.");
      }

      return emptyResult(
        "docx",
        "This file is not a readable Word document (word/document.xml is missing). Save it again as DOCX or export as PDF or text.",
      );
    }

    const xml = decodeXmlBytes(zip.parts.get(partName));

    if (!looksLikeXml(xml)) {
      return emptyResult("docx", "The Word document is damaged or encrypted and could not be read. Export as PDF or text.");
    }

    const walked = walkDocumentXml(xml, { maxChars, maxTokens: OFFICE_TEXT_DEFAULTS.maxXmlTokens });
    const warnings = [];
    const fullText = joinLines(walked.lines);

    if (fullText === "") {
      if (walked.stopped) {
        return emptyResult("docx", "The Word document is too large to read here. Export only the program pages as PDF or text.");
      }

      warnings.push(
        walked.drawings > 0
          ? "No text was found in the Word document: it only contains images or drawings. Export it as PDF or send the images instead."
          : "No text was found in the Word document.",
      );

      return { text: "", meta: { kind: "docx", paragraphs: 0, rows: 0, truncated: false, warnings } };
    }

    if (walked.drawings > 0) {
      warnings.push(
        `${walked.drawings} image or drawing ${walked.drawings === 1 ? "object was" : "objects were"} ignored; text inside images is not read from Word files.`,
      );
    }

    const limited = limitText(fullText, maxChars, warnings);

    if (walked.stopped && !limited.truncated) {
      warnings.push(TOO_LARGE_TO_WALK_WARNING);
    }

    return {
      text: limited.text,
      meta: {
        kind: "docx",
        paragraphs: walked.paragraphs,
        rows: walked.rows,
        truncated: limited.truncated || walked.stopped,
        warnings,
      },
    };
  } catch {
    return emptyResult("docx", "The Word document could not be read. Export as PDF or text.");
  }
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54,
  55, 56, 57, 58,
]);
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);

function classifyFormatCode(code) {
  // Quoted literals, escaped characters and [colour]/[condition] blocks are
  // not format letters.
  const bare = String(code ?? "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");

  if (bare.includes("%")) {
    return "percent";
  }

  if (/[dmyhs]/i.test(bare) && !/general/i.test(bare)) {
    return "date";
  }

  return "";
}

// cellXfs index -> "date" | "percent" | ""
function readCellStyles(xml, maxTokens) {
  const custom = new Map();
  const styles = [];
  let inCellXfs = false;
  let tokensLeft = maxTokens;

  for (const token of tokenizeXml(xml)) {
    tokensLeft -= 1;
    if (tokensLeft < 0) return null;
    if (token.type === "text") continue;
    const name = localName(token.name);

    if (token.type === "open") {
      if (name === "numFmt") {
        const id = Number(getAttribute(token.attrs, "numFmtId"));
        custom.set(id, classifyFormatCode(getAttribute(token.attrs, "formatCode")));
      } else if (name === "cellXfs") {
        inCellXfs = true;
      } else if (name === "xf" && inCellXfs) {
        const id = Number(getAttribute(token.attrs, "numFmtId") ?? 0);

        if (custom.has(id)) styles.push(custom.get(id));
        else if (BUILTIN_DATE_FORMATS.has(id)) styles.push("date");
        else if (BUILTIN_PERCENT_FORMATS.has(id)) styles.push("percent");
        else styles.push("");
      }
    } else if (name === "cellXfs") {
      inCellXfs = false;
    }
  }

  return styles;
}

// "_x000D_" style escapes used by Excel for control characters.
function decodeExcelEscapes(text) {
  if (!text.includes("_x")) {
    return text;
  }

  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (match, hex) => {
    const code = parseInt(hex, 16);
    // Line breaks stay line breaks here; a cell is flattened to one line later.
    if (code === 0x0a || code === 0x0d) return "\n";
    if (code === 0x09) return "\t";
    return code < 0x20 ? "" : String.fromCharCode(code);
  });
}

// Returns null when the part holds more than maxTokens tokens: a cut list
// would give wrong cell texts, so the caller refuses the workbook.
function readSharedStrings(xml, maxTokens) {
  const strings = [];
  let current = null;
  let inText = false;
  let phonetic = 0;
  let tokensLeft = maxTokens;

  for (const token of tokenizeXml(xml)) {
    tokensLeft -= 1;
    if (tokensLeft < 0) return null;

    if (token.type === "text") {
      if (current !== null && inText && phonetic === 0) current += token.text;
      continue;
    }

    const name = localName(token.name);

    if (token.type === "open") {
      if (name === "si") current = "";
      else if (name === "t") inText = true;
      else if (name === "rPh" || name === "phoneticPr") phonetic += 1;
    } else if (name === "si") {
      strings.push(decodeExcelEscapes(current ?? ""));
      current = null;
    } else if (name === "t") {
      inText = false;
    } else if (name === "rPh" || name === "phoneticPr") {
      phonetic = Math.max(0, phonetic - 1);
    }
  }

  return strings;
}

function columnIndexFromReference(reference) {
  const match = /^\$?([A-Za-z]{1,3})/.exec(String(reference ?? ""));

  if (!match) {
    return -1;
  }

  let index = 0;

  for (const char of match[1].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }

  return index - 1;
}

function tidyNumber(raw) {
  const text = String(raw ?? "").trim();

  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
    return text;
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    return text;
  }

  // Excel shows 15 significant digits; this removes 0.30000000000000004 noise.
  return String(Number(number.toPrecision(15)));
}

function formatCellValue(cell, sharedStrings, styles, notes) {
  const raw = cell.value;

  switch (cell.type) {
    case "s": {
      const index = Number(raw);
      return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : "";
    }
    case "inlineStr":
      return decodeExcelEscapes(cell.inline);
    case "str":
      return decodeExcelEscapes(raw);
    case "b":
      return raw.trim() === "1" ? "TRUE" : raw.trim() === "0" ? "FALSE" : raw.trim();
    case "e":
    case "d":
      return raw.trim();
    default: {
      if (raw.trim() === "") {
        if (cell.hasFormula) notes.formulasWithoutValue += 1;
        return cell.inline ? decodeExcelEscapes(cell.inline) : "";
      }

      const style = styles[cell.style] ?? "";

      if (style === "date") {
        notes.dateCells += 1;
        if (notes.dateExample === "") notes.dateExample = tidyNumber(raw);
        return tidyNumber(raw);
      }

      if (style === "percent") {
        const number = Number(raw);
        return Number.isFinite(number) ? `${tidyNumber(String(number * 100))}%` : raw.trim();
      }

      return tidyNumber(raw);
    }
  }
}

/**
 * `work` is shared by the sheets of one file: { tokens, chars } left. Every
 * token counts (empty rows and cells past maxColumns as well), so the walk of
 * a sheet ends after a bounded amount of work, whatever it holds.
 */
function walkSheetXml(xml, { sharedStrings, styles, maxRows, maxColumns, work }) {
  const lines = [];
  let exhausted = false;
  let rowClipped = false;
  const notes = { dateCells: 0, dateExample: "", formulasWithoutValue: 0, clippedColumns: false };
  let rowCount = 0;
  let truncated = false;
  let cells = null;
  let cell = null;
  let capture = "";
  let nextColumn = 0;
  let rowNumber = 0;
  let lastEmittedRow = 0;
  let inlineDepth = 0;
  let phonetic = 0;

  for (const token of tokenizeXml(xml)) {
    work.tokens -= 1;

    if (work.tokens < 0 || work.chars < 0) {
      exhausted = true;
      break;
    }

    if (token.type === "text") {
      if (!cell || phonetic > 0) continue;
      if (capture === "v") cell.value += token.text;
      else if (capture === "t" && inlineDepth > 0) cell.inline += token.text;
      continue;
    }

    const name = localName(token.name);

    if (token.type === "open") {
      if (name === "row") {
        if (rowCount >= maxRows) {
          truncated = true;
          break;
        }

        const declared = Number(getAttribute(token.attrs, "r"));
        rowNumber = Number.isInteger(declared) && declared > rowNumber ? declared : rowNumber + 1;
        cells = [];
        nextColumn = 0;
        rowClipped = false;
      } else if (name === "c" && cells) {
        const reference = columnIndexFromReference(getAttribute(token.attrs, "r"));
        const column = reference >= 0 ? reference : nextColumn;
        nextColumn = column + 1;

        // The row is known to be wider than what is kept: its other cells
        // past maxColumns are not read.
        if (rowClipped && column >= maxColumns) {
          cell = null;
          continue;
        }

        cell = {
          column,
          type: getAttribute(token.attrs, "t") ?? "n",
          style: Number(getAttribute(token.attrs, "s") ?? -1),
          value: "",
          inline: "",
          hasFormula: false,
        };
      } else if (cell) {
        if (name === "v") capture = "v";
        else if (name === "f") cell.hasFormula = true;
        else if (name === "is") inlineDepth += 1;
        else if (name === "t") capture = "t";
        else if (name === "rPh") phonetic += 1;
      }

      continue;
    }

    // close
    if (name === "v" || name === "t") {
      capture = "";
    } else if (name === "is") {
      inlineDepth = Math.max(0, inlineDepth - 1);
    } else if (name === "rPh") {
      phonetic = Math.max(0, phonetic - 1);
    } else if (name === "c" && cell && cells) {
      const text = singleLine(formatCellValue(cell, sharedStrings, styles, notes));

      if (text !== "") {
        if (cell.column >= maxColumns) {
          notes.clippedColumns = true;
          rowClipped = true;
        } else {
          cells[cell.column] = text;
        }
      }

      cell = null;
      capture = "";
    } else if (name === "row" && cells) {
      emitRow();
    } else if (name === "sheetData") {
      // Nothing after the cells is text (merged ranges, validation, drawings).
      break;
    }
  }

  // A walk that ran out of work in the middle of a row keeps what it read of it.
  if (exhausted && cells) {
    emitRow();
  }

  return { lines, rowCount, truncated, exhausted, notes };

  function emitRow() {
    if (cells.length > 0) {
      const values = Array.from(cells, (value) => value ?? "");

      if (lastEmittedRow > 0 && rowNumber > lastEmittedRow + 1) {
        lines.push("");
      }

      const line = values.join(" | ");
      lines.push(line);
      work.chars -= line.length + 1;
      lastEmittedRow = rowNumber;
      rowCount += 1;
    }

    cells = null;
  }
}

function readWorkbookSheets(xml) {
  const sheets = [];

  for (const token of tokenizeXml(xml)) {
    if (token.type === "open" && localName(token.name) === "sheet") {
      const attrs = token.attrs;
      let relationId = null;

      for (const [attributeName, value] of scanAttributes(attrs)) {
        // r:id, whatever prefix the relationships namespace was given.
        if (attributeName !== "sheetId" && localName(attributeName) === "id") {
          relationId = value;
        }
      }

      sheets.push({
        name: singleLine(getAttribute(attrs, "name") ?? "") || `Sheet ${sheets.length + 1}`,
        relationId,
        state: getAttribute(attrs, "state") ?? "visible",
      });
    }
  }

  return sheets;
}

/**
 * extractXlsxText(arrayBuffer, { maxChars, maxSheets, maxRows }) ->
 *   { text, meta: { kind: "xlsx", sheets, rows, truncated, warnings } }
 * One "## Sheet: <name>" header per sheet, one line per row, cells joined by
 * " | ", empty cells kept as empty columns. Formulas give their cached value,
 * dates stay the raw serial number (with a warning), percent-formatted cells
 * are written as "75%". Hidden sheets and chart sheets are skipped.
 */
export async function extractXlsxText(arrayBuffer, options = {}) {
  try {
    const maxChars = positiveInteger(options?.maxChars, OFFICE_TEXT_DEFAULTS.maxChars);
    const maxSheets = positiveInteger(options?.maxSheets, OFFICE_TEXT_DEFAULTS.maxSheets);
    const maxRows = positiveInteger(options?.maxRows, OFFICE_TEXT_DEFAULTS.maxRows);
    const maxColumns = positiveInteger(options?.maxColumns, OFFICE_TEXT_DEFAULTS.maxColumns);
    const bytes = toBytes(arrayBuffer);

    if (!bytes) {
      return emptyResult("xlsx", "The Excel file could not be read.");
    }

    const budget = createInflateBudget();
    const index = await readZipParts(
      bytes,
      (name) => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels",
      "Excel",
      budget,
    );

    if (index.error) {
      return emptyResult("xlsx", index.error);
    }

    if (!index.parts.has("xl/workbook.xml")) {
      if (index.names.includes("encryptedpackage") || index.names.includes("encryptioninfo")) {
        return emptyResult("xlsx", "This Excel file is password-protected. Remove the password or export as PDF or text.");
      }

      if (index.names.includes("word/document.xml")) {
        return emptyResult("xlsx", "This file is a Word document, not an Excel workbook. Rename it to .docx and try again.");
      }

      if (index.names.includes("xl/workbook.bin")) {
        return emptyResult("xlsx", "Excel binary workbooks (.xlsb) are not supported. Export as XLSX, PDF or text.");
      }

      return emptyResult(
        "xlsx",
        "This file is not a readable Excel workbook (xl/workbook.xml is missing). Save it again as XLSX or export as PDF or text.",
      );
    }

    const workbookXml = decodeXmlBytes(index.parts.get("xl/workbook.xml"));

    if (!looksLikeXml(workbookXml)) {
      return emptyResult("xlsx", "The Excel workbook is damaged or encrypted and could not be read. Export as PDF or text.");
    }

    const warnings = [];
    const declaredSheets = readWorkbookSheets(workbookXml);
    const relations = index.parts.has("xl/_rels/workbook.xml.rels")
      ? readRelationships(decodeXmlBytes(index.parts.get("xl/_rels/workbook.xml.rels")))
      : [];
    const relationById = new Map(relations.map((relation) => [relation.id, relation]));

    const candidates = [];
    let hidden = 0;
    let charts = 0;

    declaredSheets.forEach((sheet, position) => {
      const relation = relationById.get(sheet.relationId);

      if (relation && /\/(chartsheet|dialogsheet|macrosheet)$/i.test(relation.type)) {
        charts += 1;
        return;
      }

      if (sheet.state !== "visible") {
        hidden += 1;
        return;
      }

      const part =
        relation && !relation.external
          ? resolveTarget("xl", relation.target)
          : `xl/worksheets/sheet${position + 1}.xml`;

      candidates.push({ name: sheet.name, part });
    });

    if (hidden > 0) {
      warnings.push(`${hidden} hidden ${hidden === 1 ? "sheet was" : "sheets were"} skipped.`);
    }

    if (charts > 0) {
      warnings.push(`${charts} chart ${charts === 1 ? "sheet was" : "sheets were"} skipped.`);
    }

    if (candidates.length === 0) {
      warnings.push("No visible worksheet was found in the Excel workbook.");
      return { text: "", meta: { kind: "xlsx", sheets: 0, rows: 0, truncated: false, warnings } };
    }

    let truncated = false;

    if (candidates.length > maxSheets) {
      truncated = true;
      warnings.push(
        `The workbook has ${candidates.length} sheets; only the first ${maxSheets} were read.`,
      );
      candidates.length = maxSheets;
    }

    const wantedParts = new Set(candidates.map((candidate) => candidate.part));
    const content = await readZipParts(
      bytes,
      (name) => name === "xl/sharedstrings.xml" || name === "xl/styles.xml" || wantedParts.has(name),
      "Excel",
      budget,
    );

    if (content.error) {
      return emptyResult("xlsx", content.error);
    }

    if (content.oversized.includes("xl/sharedstrings.xml")) {
      return emptyResult("xlsx", "The Excel workbook is too large to read here. Export only the program sheet as PDF, CSV or text.");
    }

    const maxTokens = OFFICE_TEXT_DEFAULTS.maxXmlTokens;
    const sharedStrings = content.parts.has("xl/sharedstrings.xml")
      ? readSharedStrings(decodeXmlBytes(content.parts.get("xl/sharedstrings.xml")), maxTokens)
      : [];
    const styles = content.parts.has("xl/styles.xml")
      ? readCellStyles(decodeXmlBytes(content.parts.get("xl/styles.xml")), maxTokens)
      : [];

    if (sharedStrings === null || styles === null) {
      return emptyResult("xlsx", "The Excel workbook is too large to read here. Export only the program sheet as PDF, CSV or text.");
    }

    // One allowance of work for all sheets; a part is walked once even when
    // several sheets point at it.
    const work = { tokens: maxTokens, chars: maxChars };
    const walkedParts = new Map();

    const blocks = [];
    let sheetCount = 0;
    let rowTotal = 0;
    let dateCells = 0;
    let dateExample = "";
    let formulasWithoutValue = 0;

    let unreadSheets = 0;

    for (const candidate of candidates) {
      if (walkedParts.has(candidate.part)) {
        warnings.push(
          `Sheet "${candidate.name}" points at the same data as sheet "${walkedParts.get(candidate.part)}" and was skipped.`,
        );
        continue;
      }

      if (work.tokens < 0 || work.chars < 0) {
        truncated = true;
        unreadSheets += 1;
        continue;
      }

      if (!content.parts.has(candidate.part)) {
        warnings.push(
          content.oversized.includes(candidate.part)
            ? `Sheet "${candidate.name}" is too large to read and was skipped.`
            : `Sheet "${candidate.name}" could not be found in the file and was skipped.`,
        );
        if (content.oversized.includes(candidate.part)) truncated = true;
        continue;
      }

      walkedParts.set(candidate.part, candidate.name);

      const walked = walkSheetXml(decodeXmlBytes(content.parts.get(candidate.part)), {
        sharedStrings,
        styles,
        maxRows,
        maxColumns,
        work,
      });

      if (walked.exhausted) {
        truncated = true;
        warnings.push(
          `Sheet "${candidate.name}" is too large to read in full; only its first rows were read.`,
        );
      }

      if (walked.truncated) {
        truncated = true;
        warnings.push(
          `Sheet "${candidate.name}" has more than ${maxRows.toLocaleString("en-US")} rows; only the first ${maxRows.toLocaleString("en-US")} were read.`,
        );
      }

      if (walked.notes.clippedColumns) {
        truncated = true;
        warnings.push(`Sheet "${candidate.name}" has more than ${maxColumns} columns; the extra columns were skipped.`);
      }

      dateCells += walked.notes.dateCells;
      if (dateExample === "") dateExample = walked.notes.dateExample;
      formulasWithoutValue += walked.notes.formulasWithoutValue;

      if (walked.rowCount === 0) {
        continue;
      }

      sheetCount += 1;
      rowTotal += walked.rowCount;
      blocks.push(`## Sheet: ${candidate.name}\n${joinLines(walked.lines)}`);
    }

    if (unreadSheets > 0) {
      warnings.push(
        `${unreadSheets} more ${unreadSheets === 1 ? "sheet was" : "sheets were"} not read: the workbook is too large to read in full.`,
      );
    }

    if (blocks.length === 0) {
      warnings.push("No cell values were found in the Excel workbook.");
      return { text: "", meta: { kind: "xlsx", sheets: 0, rows: 0, truncated, warnings } };
    }

    if (dateCells > 0) {
      warnings.push(
        `${dateCells} date ${dateCells === 1 ? "cell is" : "cells are"} shown as the raw Excel serial number (for example ${dateExample}), not as a calendar date.`,
      );
    }

    if (formulasWithoutValue > 0) {
      warnings.push(
        `${formulasWithoutValue} formula ${formulasWithoutValue === 1 ? "cell has" : "cells have"} no saved result and ${formulasWithoutValue === 1 ? "is" : "are"} empty. Open and save the workbook in Excel to store the values.`,
      );
    }

    const limited = limitText(blocks.join("\n\n"), maxChars, warnings);

    return {
      text: limited.text,
      meta: {
        kind: "xlsx",
        sheets: sheetCount,
        rows: rowTotal,
        truncated: truncated || limited.truncated,
        warnings,
      },
    };
  } catch {
    return emptyResult("xlsx", "The Excel workbook could not be read. Export as PDF, CSV or text.");
  }
}
