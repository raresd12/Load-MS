import { buildDefaultSeedCollections } from "./programStorage.js";
import { getCollection } from "./repository.js";
import { canonicalJson, recordIdOf, recordKey } from "./syncRecords.js";

// ---------------------------------------------------------------------------
// Built-in default records and the sync (decision H6-38). Every install seeds
// the same default programs, but stamps them with its own time: the only
// device-specific fields of a seed record are its top-level createdAt and
// updatedAt. A link, a refetch and the preview therefore compare a record the
// built-in seed also has without those two fields, and know when one side is
// still the untouched default:
// - "same": the two differ only in seed time -> the account's copy is taken
//   silently, nothing is kept aside;
// - "accountDefault": the account still has the default, this device changed
//   it -> Merge keeps the device's version live (it is pushed next);
// - "deviceDefault": this device still has the default, the account changed
//   it -> the account's version is taken, nothing is kept aside;
// - null: anything else (the H6-9 rule applies).
// Pure: no storage, no network.
// ---------------------------------------------------------------------------

export const SEED_TIME_FIELDS = Object.freeze(["createdAt", "updatedAt"]);

export const SEED_PAIR_KINDS = Object.freeze({
  same: "same",
  accountDefault: "accountDefault",
  deviceDefault: "deviceDefault",
});

let cachedIndex = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** canonicalJson of the body without its top-level createdAt / updatedAt. */
export function seedComparableText(body) {
  if (!isPlainObject(body)) {
    return canonicalJson(body);
  }

  const copy = { ...body };
  SEED_TIME_FIELDS.forEach((field) => delete copy[field]);
  return canonicalJson(copy);
}

/**
 * Map "<collection>\u001f<recordId>" -> seedComparableText of the built-in
 * default record. Built once from buildDefaultSeedCollections().
 */
export function getDefaultSeedIndex() {
  if (cachedIndex) {
    return cachedIndex;
  }

  const index = new Map();
  const collections = buildDefaultSeedCollections();

  for (const [name, list] of Object.entries(collections)) {
    const descriptor = getCollection(name);

    if (!descriptor?.syncable || !Array.isArray(list)) {
      continue;
    }

    for (const record of list) {
      const recordId = recordIdOf(descriptor, record);

      if (recordId !== null) {
        index.set(recordKey(name, recordId), seedComparableText(record));
      }
    }
  }

  cachedIndex = index;
  return index;
}

/**
 * How a device body and an account body of the same record relate to the
 * built-in seed. -> "same" | "accountDefault" | "deviceDefault" | null.
 * Only records the seed has are looked at; both bodies must be live.
 */
export function classifySeedPair(key, deviceBody, accountBody, index = getDefaultSeedIndex()) {
  const seedText = index.get(key);

  if (seedText === undefined) {
    return null;
  }

  const deviceText = seedComparableText(deviceBody);
  const accountText = seedComparableText(accountBody);

  if (deviceText === accountText) {
    return SEED_PAIR_KINDS.same;
  }

  if (accountText === seedText) {
    return SEED_PAIR_KINDS.accountDefault;
  }

  if (deviceText === seedText) {
    return SEED_PAIR_KINDS.deviceDefault;
  }

  return null;
}
