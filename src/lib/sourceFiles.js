// The single place that turns picked files into an extraction source
// (decisions H3-1 and H3-2).
//
// Multi-file workflow (H3-1): several IMAGES of one program are ONE source in
// the order the user chose (page 1..N). PDF, DOCX, XLSX and text files are
// single-file sources. Merging separate extractions is not offered.
//
// Privacy (handoff 13.4): nothing here stores anything. A source carries the
// extracted text (text / office files) or the base64 needed for the request
// (images, PDF) in `files[].dataBase64`, and nowhere else: never in `meta`,
// never in `text`.
//
// Browser readers are injected so Node fixtures can run; without them the
// Blob methods `file.text()` / `file.arrayBuffer()` are used.

// officeText.js (the DOCX / XLSX parser) is loaded with a dynamic import()
// when such a file is read, so picking text, photos or a PDF never loads it
// (decision H3-23).

const MIB = 1024 * 1024;

export const SOURCE_LIMITS = Object.freeze({
  MAX_SOURCE_TEXT_CHARS: 80000,
  MAX_IMAGE_FILE_BYTES: 8 * MIB,
  MAX_PDF_FILE_BYTES: 10 * MIB,
  MAX_TEXT_FILE_BYTES: 1 * MIB,
  MAX_OFFICE_FILE_BYTES: 5 * MIB,
  MAX_IMAGES_PER_SOURCE: 6,
  // Counted on the base64 form, which is what travels inside the request.
  MAX_TOTAL_INLINE_BYTES: 18 * MIB,
  MAX_XLSX_SHEETS: 10,
  MAX_XLSX_ROWS_PER_SHEET: 2000,
});

export const UNSUPPORTED_SOURCE_FALLBACK = "For now, copy/paste the content or export as PDF/text.";
export const LEGACY_OFFICE_GUIDANCE = "Open it and export as DOCX, XLSX, PDF or text.";

// A reason that already says what to do next (fix round 2, H3-14).
const OWN_NEXT_STEP_PATTERN =
  /\b(export|rename it|remove the password|save it again|paste the text|send the images|try again|open and save)\b/i;

/**
 * The error of a DOCX / XLSX that gave no text: ONE reason with ONE next
 * step. The reasons of officeText.js mostly end with their own step ("Rename
 * it to .xlsx and try again."); only a reason without one gets the general
 * paste / export line.
 */
export function describeOfficeFailure(reason) {
  const text = String(reason ?? "").trim() || "No text could be read from this document.";

  return OWN_NEXT_STEP_PATTERN.test(text) ? text : `${text} ${UNSUPPORTED_SOURCE_FALLBACK}`;
}

export const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Values for <input type="file" accept>. IMAGE_ACCEPT goes with `multiple`.
export const SOURCE_IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
export const SOURCE_FILE_ACCEPT = `.pdf,.txt,.md,.csv,.docx,.xlsx,application/pdf,text/plain,text/markdown,text/csv,${DOCX_MIME_TYPE},${XLSX_MIME_TYPE}`;

const IMAGE_MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TEXT_FILE_EXTENSIONS = new Set(["txt", "md", "csv"]);

// Formats that stay rejected, with the name shown to the user.
const LEGACY_FORMAT_LABELS = {
  doc: "Legacy Word (.doc)",
  dot: "Legacy Word template (.dot)",
  xls: "Legacy Excel (.xls)",
  xlt: "Legacy Excel template (.xlt)",
  rtf: "Rich Text (.rtf)",
  odt: "OpenDocument Text (.odt)",
  ods: "OpenDocument Spreadsheet (.ods)",
  pages: "Apple Pages (.pages)",
  numbers: "Apple Numbers (.numbers)",
  docm: "Macro-enabled Word (.docm)",
  dotx: "Word template (.dotx)",
  dotm: "Word template (.dotm)",
  xlsm: "Macro-enabled Excel (.xlsm)",
  xlsb: "Excel binary (.xlsb)",
  xltx: "Excel template (.xltx)",
  xltm: "Excel template (.xltm)",
};

const LEGACY_EXTENSION_BY_MIME = {
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.apple.pages": "pages",
  "application/vnd.apple.numbers": "numbers",
  "application/x-iwork-pages-sffpages": "pages",
  "application/x-iwork-numbers-sffnumbers": "numbers",
  "application/vnd.ms-word.document.macroenabled.12": "docm",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
};

function getFileExtension(fileName) {
  const name = String(fileName ?? "").toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / MIB)} MB`;
}

function legacyFormatError(extension) {
  return `${LEGACY_FORMAT_LABELS[extension]} files are not supported. ${LEGACY_OFFICE_GUIDANCE}`;
}

const EMPTY_FILE_ERROR = "The selected file is empty.";
const UNREADABLE_FILE_ERROR = "The file could not be read. Try selecting it again.";

/**
 * classifySourceFile(fileName, mimeType, sizeBytes) ->
 *   { ok: true, kind: "image" | "pdf" | "text" | "docx" | "xlsx", mimeType }
 *   { ok: false, error }
 * Extension first, then MIME type. Same contract as the H2 function in
 * aiProgram.js, with DOCX/XLSX accepted and legacy formats named.
 */
export function classifySourceFile(fileName, mimeType, sizeBytes) {
  const extension = getFileExtension(fileName);
  const cleanMime = String(mimeType ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const size = Number(sizeBytes) || 0;

  if (Object.prototype.hasOwnProperty.call(LEGACY_FORMAT_LABELS, extension)) {
    return { ok: false, error: legacyFormatError(extension) };
  }

  const officeKind =
    extension === "docx"
      ? "docx"
      : extension === "xlsx"
        ? "xlsx"
        : extension !== ""
          ? ""
          : cleanMime === DOCX_MIME_TYPE
            ? "docx"
            : cleanMime === XLSX_MIME_TYPE
              ? "xlsx"
              : "";

  if (officeKind) {
    const label = officeKind === "docx" ? "Word document" : "Excel workbook";

    if (size <= 0) {
      return { ok: false, error: EMPTY_FILE_ERROR };
    }

    if (size > SOURCE_LIMITS.MAX_OFFICE_FILE_BYTES) {
      return {
        ok: false,
        error: `The ${label} is too large (max ${formatMegabytes(SOURCE_LIMITS.MAX_OFFICE_FILE_BYTES)}). Keep only the program pages, or export as PDF or text.`,
      };
    }

    return { ok: true, kind: officeKind, mimeType: officeKind === "docx" ? DOCX_MIME_TYPE : XLSX_MIME_TYPE };
  }

  const imageMime =
    IMAGE_MIME_BY_EXTENSION[extension] ?? (cleanMime.startsWith("image/") ? cleanMime : "");

  if (imageMime) {
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(imageMime)) {
      return {
        ok: false,
        error: `Only JPG, PNG and WebP images are supported. ${UNSUPPORTED_SOURCE_FALLBACK}`,
      };
    }

    if (size <= 0) {
      return { ok: false, error: EMPTY_FILE_ERROR };
    }

    if (size > SOURCE_LIMITS.MAX_IMAGE_FILE_BYTES) {
      return {
        ok: false,
        error: `The image is too large (max ${formatMegabytes(SOURCE_LIMITS.MAX_IMAGE_FILE_BYTES)}). Crop or resize it and try again.`,
      };
    }

    return { ok: true, kind: "image", mimeType: imageMime };
  }

  if (extension === "pdf" || cleanMime === "application/pdf") {
    if (size <= 0) {
      return { ok: false, error: EMPTY_FILE_ERROR };
    }

    if (size > SOURCE_LIMITS.MAX_PDF_FILE_BYTES) {
      return {
        ok: false,
        error: `The PDF is too large (max ${formatMegabytes(SOURCE_LIMITS.MAX_PDF_FILE_BYTES)}). Export only the program pages and try again.`,
      };
    }

    return { ok: true, kind: "pdf", mimeType: "application/pdf" };
  }

  if (Object.prototype.hasOwnProperty.call(LEGACY_EXTENSION_BY_MIME, cleanMime) && !TEXT_FILE_EXTENSIONS.has(extension)) {
    return { ok: false, error: legacyFormatError(LEGACY_EXTENSION_BY_MIME[cleanMime]) };
  }

  if (TEXT_FILE_EXTENSIONS.has(extension) || cleanMime.startsWith("text/")) {
    if (size <= 0) {
      return { ok: false, error: EMPTY_FILE_ERROR };
    }

    if (size > SOURCE_LIMITS.MAX_TEXT_FILE_BYTES) {
      return {
        ok: false,
        error: `The text file is too large (max ${formatMegabytes(SOURCE_LIMITS.MAX_TEXT_FILE_BYTES)}). Paste only the program part instead.`,
      };
    }

    return { ok: true, kind: "text", mimeType: "text/plain" };
  }

  return {
    ok: false,
    error: `This file type is not supported. ${UNSUPPORTED_SOURCE_FALLBACK}`,
  };
}

/**
 * classifySourceSelection(files) -> what one pick of 1..N files becomes.
 *   { ok: true, kind: "image" | "pdf" | "text" | "docx" | "xlsx" | "images", items }
 *   { ok: false, error, items }
 * `files` are File-like ({ name, type, size }); `items` holds one
 * classifySourceFile result per file, in the picked order.
 */
export function classifySourceSelection(files) {
  const list = Array.from(files ?? []);
  const items = list.map((file) => classifySourceFile(file?.name, file?.type, file?.size));

  if (list.length === 0) {
    return { ok: false, error: "Choose a file first.", items };
  }

  const failedIndex = items.findIndex((item) => !item.ok);

  if (failedIndex >= 0) {
    const prefix = list.length > 1 ? `${String(list[failedIndex]?.name ?? "File")}: ` : "";
    return { ok: false, error: `${prefix}${items[failedIndex].error}`, items };
  }

  if (list.length === 1) {
    return { ok: true, kind: items[0].kind, items };
  }

  if (items.some((item) => item.kind !== "image")) {
    return { ok: false, error: MIXED_BUNDLE_ERROR, items };
  }

  if (list.length > SOURCE_LIMITS.MAX_IMAGES_PER_SOURCE) {
    return { ok: false, error: TOO_MANY_IMAGES_ERROR, items };
  }

  const inlineBytes = list.reduce((sum, file) => sum + estimateInlineBytes(file?.size), 0);

  if (inlineBytes > SOURCE_LIMITS.MAX_TOTAL_INLINE_BYTES) {
    return { ok: false, error: TOTAL_TOO_LARGE_ERROR, items };
  }

  return { ok: true, kind: "images", items };
}

const MIXED_BUNDLE_ERROR =
  "Several files can only be sent together when all of them are images (JPG, PNG or WebP) of the same program. A PDF, Word, Excel or text file is always sent alone.";
const TOO_MANY_IMAGES_ERROR = `Too many images: one program can have at most ${SOURCE_LIMITS.MAX_IMAGES_PER_SOURCE} images. Remove some, or export the program as one PDF.`;
const TOTAL_TOO_LARGE_ERROR = `The images are too large together (max ${formatMegabytes(SOURCE_LIMITS.MAX_TOTAL_INLINE_BYTES)} once encoded for the request). Crop or resize them, or use fewer images.`;

/** Size of `sizeBytes` raw bytes once base64-encoded for the request. */
export function estimateInlineBytes(sizeBytes) {
  const size = Math.max(0, Number(sizeBytes) || 0);
  return Math.ceil(size / 3) * 4;
}

// ---------------------------------------------------------------------------
// Bytes, base64 and signatures
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Bytes per btoa call: a multiple of 3, so every piece but the last encodes
// without padding and the pieces can simply be joined.
const BASE64_PIECE_BYTES = 3 * 8192;

/**
 * Base64 of bytes. The encoding itself is done by the engine
 * (Uint8Array.prototype.toBase64, else btoa over pieces), which is many times
 * faster than a loop in script; bytesToBase64Portable is the fallback where
 * neither exists (fix round 1).
 */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? new ArrayBuffer(0));

  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64();
  }

  if (typeof btoa !== "function") {
    return bytesToBase64Portable(bytes);
  }

  const pieces = [];

  for (let offset = 0; offset < bytes.length; offset += BASE64_PIECE_BYTES) {
    pieces.push(btoa(String.fromCharCode.apply(null, bytes.subarray(offset, offset + BASE64_PIECE_BYTES))));
  }

  return pieces.join("");
}

export function bytesToBase64Portable(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? new ArrayBuffer(0));
  const chunks = [];
  let chunk = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;

    chunk += BASE64_ALPHABET[a >> 2];
    chunk += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    chunk += index + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    chunk += index + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : "=";

    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = "";
    }
  }

  chunks.push(chunk);
  return chunks.join("");
}

// Decodes only the first `maxBytes` bytes (signature checks).
function base64HeadToBytes(base64, maxBytes) {
  const clean = String(base64 ?? "").slice(0, Math.ceil(maxBytes / 3) * 4);
  const out = [];

  for (let index = 0; index < clean.length; index += 4) {
    const values = [0, 1, 2, 3].map((offset) => BASE64_ALPHABET.indexOf(clean[index + offset] ?? "="));

    if (values[0] < 0 || values[1] < 0) break;
    out.push((values[0] << 2) | (values[1] >> 4));
    if (values[2] < 0) break;
    out.push(((values[1] & 15) << 4) | (values[2] >> 2));
    if (values[3] < 0) break;
    out.push(((values[2] & 3) << 6) | values[3]);
  }

  return Uint8Array.from(out.slice(0, maxBytes));
}

function matchesAt(bytes, offset, values) {
  return bytes.length >= offset + values.length && values.every((value, index) => bytes[offset + index] === value);
}

/**
 * detectFileSignature(bytes) -> "png" | "jpeg" | "webp" | "gif" | "pdf" |
 *   "zip" | "ole" | "rtf" | "" (unknown). Reads at most the first 1024 bytes.
 */
export function detectFileSignature(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? new ArrayBuffer(0));

  if (matchesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matchesAt(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matchesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  if (matchesAt(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (matchesAt(bytes, 0, [0xd0, 0xcf, 0x11, 0xe0])) return "ole";
  if (matchesAt(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) || matchesAt(bytes, 0, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (matchesAt(bytes, 0, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "rtf";

  // "%PDF-" may be preceded by a few junk bytes.
  const limit = Math.min(bytes.length, 1024) - 4;

  for (let index = 0; index < limit; index += 1) {
    if (matchesAt(bytes, index, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  }

  return "";
}

const IMAGE_MIME_BY_SIGNATURE = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function buildMeta(origin, overrides = {}) {
  return {
    origin,
    pages: null,
    sheets: null,
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

function failure(error, warnings = []) {
  return {
    ok: false,
    error,
    kind: null,
    files: [],
    meta: buildMeta("file", { warnings: [...warnings] }),
  };
}

function normalizeText(text) {
  const value = String(text ?? "");
  return (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value).replace(/\r\n?/g, "\n");
}

/**
 * buildTextSource(text) -> the source for pasted text.
 *   { ok: true, kind: "text", text, files: [], meta: { origin: "paste", ... } }
 *   { ok: false, error, ... } when empty or over MAX_SOURCE_TEXT_CHARS.
 */
export function buildTextSource(text) {
  const clean = normalizeText(text);

  if (clean.trim() === "") {
    return { ...failure("Paste the program text first."), meta: buildMeta("paste") };
  }

  if (clean.trim().length > SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS) {
    return {
      ...failure(
        `The pasted text is too long (over ${SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS.toLocaleString("en-US")} characters). Split it into smaller parts.`,
      ),
      meta: buildMeta("paste"),
    };
  }

  return { ok: true, kind: "text", text: clean, files: [], meta: buildMeta("paste") };
}

function resolveReaders(readers) {
  return {
    readAsText:
      typeof readers?.readAsText === "function"
        ? readers.readAsText
        : (file) => (typeof file?.text === "function" ? file.text() : Promise.reject(new Error("no text reader"))),
    readAsArrayBuffer:
      typeof readers?.readAsArrayBuffer === "function"
        ? readers.readAsArrayBuffer
        : typeof readers?.readAsDataUrl === "function"
          ? null
          : (file) =>
              typeof file?.arrayBuffer === "function"
                ? file.arrayBuffer()
                : Promise.reject(new Error("no binary reader")),
    readAsDataUrl: typeof readers?.readAsDataUrl === "function" ? readers.readAsDataUrl : null,
    injectedTextReader: typeof readers?.readAsText === "function",
    injectedBinaryReader: typeof readers?.readAsArrayBuffer === "function",
  };
}

// ---------------------------------------------------------------------------
// Text files are checked by content too (fix round 1): a picture or a Word
// file renamed to .txt is refused, a UTF-16 "Unicode Text" export is decoded.
// ---------------------------------------------------------------------------

const TEXT_SNIFF_BYTES = 4096;
const TEXT_SIGNATURE_ERRORS = {
  png: "This file is not text: it is a PNG image. Pick it as a photo instead.",
  jpeg: "This file is not text: it is a JPG image. Pick it as a photo instead.",
  webp: "This file is not text: it is a WebP image. Pick it as a photo instead.",
  gif: `This file is not text: it is a GIF image. ${UNSUPPORTED_SOURCE_FALLBACK}`,
  pdf: "This file is not text: it is a PDF. Rename it to .pdf and pick it again.",
  zip: "This file is not text: it looks like a Word or Excel document. Rename it to .docx or .xlsx and pick it again.",
  ole: `This file is not text: it looks like a legacy Office document. ${LEGACY_OFFICE_GUIDANCE}`,
  rtf: `This file is not text: it is a Rich Text (.rtf) document. ${LEGACY_OFFICE_GUIDANCE}`,
};
const BINARY_TEXT_ERROR = `This file is not readable text (it holds binary data). ${UNSUPPORTED_SOURCE_FALLBACK}`;
export const UTF16_TEXT_WARNING = "The file was saved as UTF-16 (Unicode text) and was converted.";
// Decision H3-22: text that is not UTF-8.
export const LEGACY_ENCODING_TEXT_WARNING =
  "The file is not saved as UTF-8; it was read as Windows-1250 (Central European). Check the letters with diacritics in the text below.";
export const LOST_CHARACTERS_TEXT_WARNING =
  "Some characters could not be read and are shown as �. Check the text below, or save the file as UTF-8 and pick it again.";
export const UNKNOWN_ENCODING_TEXT_ERROR =
  "This text file is not saved as UTF-8 and its encoding could not be recognised. Save it as UTF-8 text and pick it again, or copy/paste the content.";
// Decision H3-23: the parser is a lazy chunk; when it cannot be fetched the
// reason and the next step are said.
export const OFFICE_READER_LOAD_ERROR =
  "The Word / Excel reader could not be loaded. Check the connection and try again, or paste the text.";
const LEGACY_TEXT_ENCODING = "windows-1250";
// Romanian, Polish, Czech or Hungarian text holds a letter with a diacritic
// every 8 to 20 characters. A file where more than this share of the bytes is
// above 0x7F is another alphabet in another code page, or not text.
const MAX_LEGACY_HIGH_BYTE_SHARE = 0.3;
const REPLACEMENT_CHARACTER = "�";

function withLostCharacterWarning(text, warnings = []) {
  return text.includes(REPLACEMENT_CHARACTER) ? [...warnings, LOST_CHARACTERS_TEXT_WARNING] : warnings;
}

/**
 * Bytes that are not UTF-8 as { text, warnings } or { error }: read as
 * Windows-1250 when they look like 8-bit text of a Latin alphabet.
 */
function decodeLegacyText(bytes) {
  let high = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] >= 0x80) {
      high += 1;
    }
  }

  let text;

  try {
    text = new TextDecoder(LEGACY_TEXT_ENCODING).decode(bytes);
  } catch {
    // An engine without that code page: the letters are lost, and said so.
    text = new TextDecoder("utf-8").decode(bytes);
    return looksLikeBinaryText(text) ? { error: BINARY_TEXT_ERROR } : { text, warnings: withLostCharacterWarning(text) };
  }

  if (looksLikeBinaryText(text)) {
    return { error: BINARY_TEXT_ERROR };
  }

  if (high > bytes.length * MAX_LEGACY_HIGH_BYTE_SHARE) {
    return { error: UNKNOWN_ENCODING_TEXT_ERROR };
  }

  return { text, warnings: withLostCharacterWarning(text, [LEGACY_ENCODING_TEXT_WARNING]) };
}

function isBinaryControlCode(code) {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) || code === 0x7f;
}

/** "utf-16le" | "utf-16be" | "" from a byte-order mark, or from the NUL pattern of plain ASCII text. */
function detectUtf16(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  const length = Math.min(bytes.length, TEXT_SNIFF_BYTES) & ~1;

  if (length < 8) {
    return "";
  }

  let evenZeros = 0;
  let oddZeros = 0;

  for (let index = 0; index < length; index += 2) {
    if (bytes[index] === 0) evenZeros += 1;
    if (bytes[index + 1] === 0) oddZeros += 1;
  }

  const pairs = length / 2;

  if (oddZeros >= pairs * 0.6 && evenZeros <= pairs * 0.05) return "utf-16le";
  if (evenZeros >= pairs * 0.6 && oddZeros <= pairs * 0.05) return "utf-16be";

  return "";
}

function decodeUtf16(bytes, encoding) {
  if (encoding === "utf-16le") {
    return new TextDecoder("utf-16le").decode(bytes);
  }

  const swapped = new Uint8Array(bytes.length & ~1);

  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }

  return new TextDecoder("utf-16le").decode(swapped);
}

/** True when decoded text is really binary data: a NUL, or control characters all over. */
function looksLikeBinaryText(text) {
  const head = text.slice(0, TEXT_SNIFF_BYTES);
  let controls = 0;

  for (let index = 0; index < head.length; index += 1) {
    const code = head.charCodeAt(index);

    if (code === 0) {
      return true;
    }

    if (isBinaryControlCode(code)) {
      controls += 1;
    }
  }

  return controls > Math.max(2, head.length * 0.01);
}

/**
 * The text of a .txt / .md / .csv file as { text, warnings } or { error }.
 * With the file's bytes at hand (no injected text reader) the content
 * signature is checked and UTF-16 is decoded; text from an injected reader is
 * checked for binary data only.
 */
async function readTextFile(file, readers) {
  const canReadBytes = readers.injectedBinaryReader || typeof file?.arrayBuffer === "function";

  if (readers.injectedTextReader || !canReadBytes) {
    const text = String((await readers.readAsText(file)) ?? "");
    const head = Uint8Array.from(text.slice(0, 16), (char) => char.charCodeAt(0) & 0xff);
    const signature = detectFileSignature(head);

    if (signature && TEXT_SIGNATURE_ERRORS[signature]) {
      return { error: TEXT_SIGNATURE_ERRORS[signature] };
    }

    return looksLikeBinaryText(text) ? { error: BINARY_TEXT_ERROR } : { text, warnings: withLostCharacterWarning(text) };
  }

  const readBytes = readers.readAsArrayBuffer ?? ((picked) => picked.arrayBuffer());
  const bytes = toUint8Array(await readBytes(file));

  if (!bytes) {
    return { error: UNREADABLE_FILE_ERROR };
  }

  if (bytes.length > SOURCE_LIMITS.MAX_TEXT_FILE_BYTES) {
    return { error: classifySourceFile(file.name, file.type, bytes.length).error };
  }

  const utf16 = detectUtf16(bytes);

  if (utf16) {
    const text = decodeUtf16(bytes, utf16);
    return looksLikeBinaryText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
      ? { error: BINARY_TEXT_ERROR }
      : { text, warnings: withLostCharacterWarning(text, [UTF16_TEXT_WARNING]) };
  }

  // The first bytes only: "%PDF-" further down is a sentence, not a PDF.
  const signature = detectFileSignature(bytes.subarray(0, 16));

  if (signature && TEXT_SIGNATURE_ERRORS[signature]) {
    return { error: TEXT_SIGNATURE_ERRORS[signature] };
  }

  let text;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeLegacyText(bytes);
  }

  return looksLikeBinaryText(text) ? { error: BINARY_TEXT_ERROR } : { text, warnings: withLostCharacterWarning(text) };
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength);
  }
  return null;
}

/**
 * The browser's own encoder, used when the caller injected no binary reader
 * and the file is a real Blob: FileReader.readAsDataURL encodes off the main
 * thread, so "Reading your program..." can paint while a large photo or PDF
 * is read (fix round 1). null where FileReader does not exist (Node fixtures).
 */
function getNativeDataUrlReader(file) {
  if (
    typeof FileReader !== "function" ||
    typeof Blob !== "function" ||
    !(file instanceof Blob)
  ) {
    return null;
  }

  return (picked) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.onabort = () => reject(new Error("read aborted"));
      reader.readAsDataURL(picked);
    });
}

async function readInlineBase64(file, readers) {
  const readAsDataUrl = readers.readAsDataUrl ?? (readers.injectedBinaryReader ? null : getNativeDataUrlReader(file));

  if (readAsDataUrl) {
    const dataUrl = String((await readAsDataUrl(file)) ?? "");
    const comma = dataUrl.indexOf(",");
    const base64 = (dataUrl.startsWith("data:") && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl).replace(/\s+/g, "");
    return { base64, head: base64HeadToBytes(base64, 1026) };
  }

  const bytes = toUint8Array(await readers.readAsArrayBuffer(file));

  if (!bytes) {
    return { base64: "", head: new Uint8Array(0) };
  }

  return { base64: bytesToBase64(bytes), head: bytes.subarray(0, 1026) };
}

/**
 * readSourceFile(file, { readAsText, readAsArrayBuffer, readAsDataUrl }) ->
 *   Promise of a normalised source, never rejected:
 *   { ok: true, kind: "text" | "image" | "pdf",
 *     text?,                                  // text, DOCX and XLSX files
 *     files: [{ name, mimeType, sizeBytes, dataBase64? }],  // dataBase64: image / pdf only
 *     meta: { origin: "file" | "office", format?, pages, sheets, paragraphs?, rows?, truncated, warnings } }
 *   { ok: false, error, kind: null, files: [], meta }
 * DOCX / XLSX become kind "text" with meta.origin "office" and the extracted
 * text, so the user can read exactly what is sent.
 */
export async function readSourceFile(file, readers = {}) {
  try {
    if (!file || typeof file !== "object") {
      return failure("Choose a file first.");
    }

    const name = String(file.name ?? "");
    const sizeBytes = Number(file.size) || 0;
    const classified = classifySourceFile(name, file.type, sizeBytes);

    if (!classified.ok) {
      return failure(classified.error);
    }

    const use = resolveReaders(readers);
    const entry = { name, mimeType: classified.mimeType, sizeBytes };

    if (classified.kind === "text") {
      const read = await readTextFile(file, use);

      if (read.error) {
        return failure(read.error);
      }

      const text = normalizeText(read.text);

      if (text.trim() === "") {
        return failure("The text file has no readable text.");
      }

      if (text.trim().length > SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS) {
        return failure(
          `The text file is too long (over ${SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS.toLocaleString("en-US")} characters). Keep only the program part.`,
        );
      }

      return { ok: true, kind: "text", text, files: [entry], meta: buildMeta("file", { warnings: read.warnings }) };
    }

    if (classified.kind === "docx" || classified.kind === "xlsx") {
      const read = use.readAsArrayBuffer ?? ((picked) => picked.arrayBuffer());
      const bytes = toUint8Array(await read(file));

      if (!bytes || bytes.length === 0) {
        return failure(UNREADABLE_FILE_ERROR);
      }

      if (bytes.length > SOURCE_LIMITS.MAX_OFFICE_FILE_BYTES) {
        return failure(classifySourceFile(name, file.type, bytes.length).error);
      }

      let office;

      try {
        office = await import("./officeText.js");
      } catch {
        return failure(OFFICE_READER_LOAD_ERROR);
      }

      const { extractDocxText, extractXlsxText } = office;
      const extracted =
        classified.kind === "docx"
          ? await extractDocxText(bytes, { maxChars: SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS })
          : await extractXlsxText(bytes, {
              maxChars: SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS,
              maxSheets: SOURCE_LIMITS.MAX_XLSX_SHEETS,
              maxRows: SOURCE_LIMITS.MAX_XLSX_ROWS_PER_SHEET,
            });
      const warnings = [...(extracted.meta?.warnings ?? [])];

      if (!extracted.text) {
        // The reason is the last line: what was skipped on the way comes first.
        return failure(describeOfficeFailure(warnings[warnings.length - 1]), warnings);
      }

      return {
        ok: true,
        kind: "text",
        text: extracted.text,
        files: [entry],
        meta: buildMeta("office", {
          format: classified.kind,
          sheets: classified.kind === "xlsx" ? extracted.meta.sheets : null,
          paragraphs: classified.kind === "docx" ? extracted.meta.paragraphs : null,
          rows: extracted.meta.rows,
          truncated: Boolean(extracted.meta.truncated),
          warnings,
        }),
      };
    }

    // image / pdf: inline base64
    const { base64, head } = await readInlineBase64(file, use);

    if (!base64) {
      return failure(UNREADABLE_FILE_ERROR);
    }

    const signature = detectFileSignature(head);

    if (classified.kind === "pdf") {
      if (signature !== "pdf") {
        return failure(
          signature === "ole"
            ? `This file is not a PDF: it looks like a legacy Office document. ${LEGACY_OFFICE_GUIDANCE}`
            : `This file is not a valid PDF. ${UNSUPPORTED_SOURCE_FALLBACK}`,
        );
      }

      return {
        ok: true,
        kind: "pdf",
        files: [{ ...entry, dataBase64: base64 }],
        meta: buildMeta("file"),
      };
    }

    const sniffedMime = IMAGE_MIME_BY_SIGNATURE[signature];

    if (!sniffedMime) {
      return failure(`This file is not a valid JPG, PNG or WebP image. ${UNSUPPORTED_SOURCE_FALLBACK}`);
    }

    return {
      ok: true,
      kind: "image",
      files: [{ ...entry, mimeType: sniffedMime, dataBase64: base64 }],
      meta: buildMeta("file", { pages: 1 }),
    };
  } catch {
    return failure(UNREADABLE_FILE_ERROR);
  }
}

function toBundleEntry(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  // A source returned by readSourceFile, or one of its `files` entries.
  if (Array.isArray(item.files)) {
    if (item.ok === false || item.files.length !== 1) {
      return { kind: item.kind ?? "", entry: null };
    }

    return { kind: item.kind, entry: item.files[0] };
  }

  const mimeType = String(item.mimeType ?? "").toLowerCase();

  return {
    kind: SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? "image" : mimeType === "application/pdf" ? "pdf" : "other",
    entry: item,
  };
}

/**
 * buildImageBundle(files, order) -> several images of ONE program as one source.
 *   files: image sources from readSourceFile, or their file entries
 *          ({ name, mimeType, sizeBytes, dataBase64 })
 *   order: optional array of indexes into `files` (each index exactly once);
 *          omitted = the given order. Page 1 is order[0].
 *   { ok: true, kind: "images",
 *     files: [{ name, mimeType, sizeBytes, dataBase64, page, pageLabel }],
 *     meta: { origin: "file", pages: N, sheets: null, truncated: false, warnings: [] } }
 *   { ok: false, error, kind: null, files: [], meta }
 */
export function buildImageBundle(files, order) {
  const list = Array.from(files ?? []);

  if (list.length === 0) {
    return failure("Choose at least one image first.");
  }

  if (list.length > SOURCE_LIMITS.MAX_IMAGES_PER_SOURCE) {
    return failure(TOO_MANY_IMAGES_ERROR);
  }

  const indexes = order === undefined || order === null ? list.map((_, index) => index) : Array.from(order);
  const seen = new Set();

  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= list.length || seen.has(index)) {
      return failure("The page order is not valid: every image must appear exactly once.");
    }

    seen.add(index);
  }

  if (indexes.length !== list.length) {
    return failure("The page order is not valid: every image must appear exactly once.");
  }

  const entries = [];

  for (const index of indexes) {
    const resolved = toBundleEntry(list[index]);

    if (!resolved || resolved.kind !== "image") {
      return failure(MIXED_BUNDLE_ERROR);
    }

    const { entry } = resolved;
    const mimeType = String(entry?.mimeType ?? "").toLowerCase();
    const dataBase64 = String(entry?.dataBase64 ?? "");

    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      return failure(MIXED_BUNDLE_ERROR);
    }

    if (!dataBase64) {
      return failure(UNREADABLE_FILE_ERROR);
    }

    entries.push({
      name: String(entry.name ?? ""),
      mimeType,
      sizeBytes: Number(entry.sizeBytes) || 0,
      dataBase64,
    });
  }

  const oversized = entries.find((entry) => entry.sizeBytes > SOURCE_LIMITS.MAX_IMAGE_FILE_BYTES);

  if (oversized) {
    return failure(classifySourceFile(oversized.name || "image.png", oversized.mimeType, oversized.sizeBytes).error);
  }

  const inlineBytes = entries.reduce(
    (sum, entry) => sum + Math.max(entry.dataBase64.length, estimateInlineBytes(entry.sizeBytes)),
    0,
  );

  if (inlineBytes > SOURCE_LIMITS.MAX_TOTAL_INLINE_BYTES) {
    return failure(TOTAL_TOO_LARGE_ERROR);
  }

  const total = entries.length;

  return {
    ok: true,
    kind: "images",
    files: entries.map((entry, position) => ({
      ...entry,
      page: position + 1,
      pageLabel: `Page ${position + 1} of ${total}`,
    })),
    meta: buildMeta("file", { pages: total }),
  };
}
