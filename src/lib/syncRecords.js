import { COLLECTION_KINDS, getCollection, getSyncableCollections } from "./repository.js";

// ---------------------------------------------------------------------------
// Private sync: records, canonical form, content hash and the push diff
// (Phase H6, decisions H6-5, H6-7, H6-10). Pure logic: no storage, no network.
// The only platform dependency is globalThis.crypto.subtle for SHA-256.
// ---------------------------------------------------------------------------

/** The hash of a tombstone (decision H6-5). */
export const DELETED_HASH = "deleted";

/** Separator of a meta.records key: "<collection>\u001f<recordId>" (H6-7). */
export const RECORD_KEY_SEPARATOR = "\u001f";

/** A push deleting more than this many records needs confirmation (H6-10). */
export const MASS_DELETE_LIMIT = 20;

/** At most this many ops per push request (H6-5). */
export const MAX_PUSH_OPS = 200;

/**
 * Canonical JSON (decision H6-5): what JSON.stringify writes for the same
 * value, with object keys sorted recursively in plain UTF-16 code-unit order
 * and no whitespace. undefined, functions and symbols are dropped from
 * objects and become null in arrays (a top-level one returns undefined);
 * non-finite numbers are null; toJSON() is honoured; boxed primitives are
 * unwrapped; a BigInt or a cycle throws a TypeError. server/canonical.mjs
 * keeps a byte-identical copy (the server never imports src/).
 */
export function canonicalJson(value) {
  return serializeCanonical(value, "", new Set());
}

function serializeCanonical(input, key, stack) {
  let value = input;

  if (value !== null && (typeof value === "object" || typeof value === "bigint") && typeof value.toJSON === "function") {
    value = value.toJSON(key);
  }

  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return serializeCanonical(value.valueOf(), key, stack);
  }

  if (stack.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }

  stack.add(value);

  try {
    if (Array.isArray(value)) {
      const items = [];

      for (let index = 0; index < value.length; index += 1) {
        const item = serializeCanonical(value[index], String(index), stack);
        items.push(item === undefined ? "null" : item);
      }

      return `[${items.join(",")}]`;
    }

    const parts = [];

    for (const name of Object.keys(value).sort()) {
      const item = serializeCanonical(value[name], name, stack);

      if (item !== undefined) {
        parts.push(`${JSON.stringify(name)}:${item}`);
      }
    }

    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex of a UTF-8 string, through globalThis.crypto.subtle. */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;

  if (!subtle) {
    throw new Error("crypto.subtle is not available.");
  }

  return toHex(await subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}

/** SHA-256 hex of canonicalJson(value) (decision H6-5). */
export function contentHash(value) {
  return sha256Hex(canonicalJson(value));
}

function resolveCollection(collection) {
  return typeof collection === "string" ? getCollection(collection) : collection ?? null;
}

/**
 * The sync record id (decision H6-7), or null when it cannot be derived.
 * - list collection, `recordOrKey` is the record: the `idField` value as a
 *   string; a composite idField gives JSON.stringify of its values in field
 *   order (baselines / programProgressions: '["p1","e1"]'). A missing, null
 *   or empty part gives null.
 * - map collection, `recordOrKey` is the map key (a non-empty string).
 * The id is at most 300 characters (H6-4); a longer one gives null.
 */
export function recordIdOf(collection, recordOrKey) {
  const descriptor = resolveCollection(collection);
  let id = null;

  if (descriptor?.kind === COLLECTION_KINDS.map) {
    id = typeof recordOrKey === "string" && recordOrKey ? recordOrKey : null;
  } else if (descriptor?.kind === COLLECTION_KINDS.list && recordOrKey && typeof recordOrKey === "object" && !Array.isArray(recordOrKey)) {
    const composite = Array.isArray(descriptor.idField);
    const fields = composite ? descriptor.idField : [descriptor.idField];
    const parts = fields.map((field) => recordOrKey[field]);
    const valid = parts.every(
      (part) => (typeof part === "string" && part !== "") || (typeof part === "number" && Number.isFinite(part)),
    );

    if (valid) {
      id = composite ? JSON.stringify(parts) : String(parts[0]);
    }
  }

  return id && id.length <= 300 ? id : null;
}

export function recordKey(collection, recordId) {
  return `${collection}${RECORD_KEY_SEPARATOR}${recordId}`;
}

export function parseRecordKey(key) {
  const index = String(key).indexOf(RECORD_KEY_SEPARATOR);

  return index < 0
    ? null
    : { collection: key.slice(0, index), recordId: key.slice(index + RECORD_KEY_SEPARATOR.length) };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` has the stored shape of `collection` (absent counts as empty). */
export function hasCollectionShape(collection, value) {
  const descriptor = resolveCollection(collection);

  if (value === null || value === undefined) {
    return true;
  }

  if (descriptor?.kind === COLLECTION_KINDS.list) {
    return Array.isArray(value);
  }

  if (descriptor?.kind === COLLECTION_KINDS.map) {
    return isPlainObject(value);
  }

  return false;
}

/**
 * Every syncable record on the device.
 * readCollection(name) -> the stored value of that collection.
 * Returns { records: [{ collection, recordId, body }], skipped, invalid }:
 * - a list record's body is the record, a map entry's body is its value;
 * - skipped: [{ collection, index | key, reason: "missing-id" | "duplicate-id" }]
 *   (never pushed, never deleted, left untouched by applyPulledRecords);
 * - invalid: names of collections whose stored value has the wrong shape (a
 *   list that is not an array, a map that is not an object). A sync must stop
 *   on these: reading them as empty would look like mass deletes.
 */
export function enumerateLocalRecords(readCollection) {
  const records = [];
  const skipped = [];
  const invalid = [];

  for (const collection of getSyncableCollections()) {
    const value = readCollection(collection.name);

    if (!hasCollectionShape(collection, value)) {
      invalid.push(collection.name);
      continue;
    }

    const seen = new Set();
    const add = (recordId, body, where) => {
      if (recordId === null) {
        skipped.push({ collection: collection.name, ...where, reason: "missing-id" });
      } else if (seen.has(recordId)) {
        skipped.push({ collection: collection.name, ...where, recordId, reason: "duplicate-id" });
      } else {
        seen.add(recordId);
        records.push({ collection: collection.name, recordId, body });
      }
    };

    if (collection.kind === COLLECTION_KINDS.list) {
      (value ?? []).forEach((record, index) => add(recordIdOf(collection, record), record, { index }));
    } else {
      Object.keys(value ?? {}).forEach((key) => add(recordIdOf(collection, key), value[key], { key }));
    }
  }

  return { records, skipped, invalid };
}

/** Adds `hash` (contentHash of the body) to each enumerated record. */
export async function hashLocalRecords(records) {
  return Promise.all(records.map(async (record) => ({ ...record, hash: await contentHash(record.body) })));
}

/**
 * Applies upserts and deletes by record id to collection values.
 * pulled: [{ collection, recordId, deleted, body }] (later entries win);
 * current: { [collectionName]: storedValue }.
 * Returns { values, changed }: `values` holds a new value for every collection
 * an entry touched (inputs are never mutated) and `changed` lists the names
 * whose value actually differs. Existing records keep their position, an
 * upserted record replaces the first record with that id, new records are
 * appended in entry order, a delete removes the first record with that id
 * (records without an id or duplicates are left alone). Entries of unknown
 * or non-syncable collections are ignored.
 */
export function applyPulledRecords(pulled, current) {
  const values = {};
  const changed = new Set();

  for (const entry of Array.isArray(pulled) ? pulled : []) {
    const descriptor = getCollection(entry?.collection);

    if (!descriptor?.syncable || typeof entry.recordId !== "string") {
      continue;
    }

    const name = descriptor.name;

    if (!(name in values)) {
      const stored = current?.[name];
      values[name] =
        descriptor.kind === COLLECTION_KINDS.list
          ? Array.isArray(stored)
            ? [...stored]
            : []
          : isPlainObject(stored)
            ? { ...stored }
            : {};
    }

    const deleted = Boolean(entry.deleted);

    if (descriptor.kind === COLLECTION_KINDS.list) {
      const list = values[name];
      const index = list.findIndex((record) => recordIdOf(descriptor, record) === entry.recordId);

      if (deleted) {
        if (index >= 0) {
          list.splice(index, 1);
          changed.add(name);
        }
      } else if (index >= 0) {
        if (canonicalJson(list[index]) !== canonicalJson(entry.body)) {
          list[index] = entry.body;
          changed.add(name);
        }
      } else {
        list.push(entry.body);
        changed.add(name);
      }
    } else {
      const map = values[name];
      const has = Object.prototype.hasOwnProperty.call(map, entry.recordId);

      if (deleted) {
        if (has) {
          delete map[entry.recordId];
          changed.add(name);
        }
      } else if (!has || canonicalJson(map[entry.recordId]) !== canonicalJson(entry.body)) {
        map[entry.recordId] = entry.body;
        changed.add(name);
      }
    }
  }

  return { values, changed: [...changed] };
}

/**
 * Mass-delete guard (decision H6-10): a push that would delete more than 20
 * records, or more than a quarter of the account's live records, stops and
 * asks first.
 */
export function needsMassDeleteConfirmation(deleteCount, liveCount) {
  const deletes = Number(deleteCount) || 0;
  const live = Number(liveCount) || 0;

  return deletes > MASS_DELETE_LIMIT || deletes * 4 > live;
}

/**
 * The op id (decision H6-7): SHA-256 hex of the canonical JSON of
 * [deviceId, collection, recordId, baseRev, deleted, hash], so a retry of the
 * same change sends the same id.
 */
export function computeOpId({ deviceId, collection, recordId, baseRev, deleted, hash }) {
  return sha256Hex(canonicalJson([String(deviceId ?? ""), collection, recordId, baseRev, Boolean(deleted), hash]));
}

/**
 * The push diff (decisions H6-7, H6-10).
 * local: hashed records [{ collection, recordId, body, hash }] (every
 *   syncable record on the device, from enumerateLocalRecords +
 *   hashLocalRecords);
 * meta: the sync meta ({ deviceId, records: { "<c>\u001f<id>": { rev, hash } } }).
 * Returns Promise<{ ops, deleteCount, liveCount, needsConfirmation }>:
 * - ops: [{ opId, collection, recordId, baseRev, deleted, body, hash }] in
 *   local order, then deletes in meta order. A new record has baseRev 0 (or
 *   the tombstone's rev when the account deleted that id), a changed record
 *   the known rev; a record known live to the account and gone from the device
 *   is a delete (body null, hash "deleted"). `hash` is client bookkeeping and
 *   is not sent (syncApi.push strips it).
 * - liveCount: records the device knows to be live in the account.
 */
export async function diffForPush(local, meta) {
  const known = isPlainObject(meta?.records) ? meta.records : {};
  const deviceId = meta?.deviceId ?? "";
  const present = new Set();
  const pending = [];

  for (const record of Array.isArray(local) ? local : []) {
    const key = recordKey(record.collection, record.recordId);
    const entry = known[key];
    present.add(key);

    if (entry && entry.hash === record.hash) {
      continue;
    }

    pending.push({
      collection: record.collection,
      recordId: record.recordId,
      baseRev: entry ? Number(entry.rev) || 0 : 0,
      deleted: false,
      body: record.body,
      hash: record.hash,
    });
  }

  let liveCount = 0;
  let deleteCount = 0;

  for (const [key, entry] of Object.entries(known)) {
    if (!entry || entry.hash === DELETED_HASH) {
      continue;
    }

    liveCount += 1;

    if (present.has(key)) {
      continue;
    }

    const parsed = parseRecordKey(key);

    if (!parsed || !getCollection(parsed.collection)?.syncable) {
      continue;
    }

    deleteCount += 1;
    pending.push({
      collection: parsed.collection,
      recordId: parsed.recordId,
      baseRev: Number(entry.rev) || 0,
      deleted: true,
      body: null,
      hash: DELETED_HASH,
    });
  }

  const ops = await Promise.all(
    pending.map(async (op) => ({ opId: await computeOpId({ deviceId, ...op }), ...op })),
  );

  return {
    ops,
    deleteCount,
    liveCount,
    needsConfirmation: deleteCount > 0 && needsMassDeleteConfirmation(deleteCount, liveCount),
  };
}
