import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

// Password, recovery code and token handling (decisions H6-2, H6-3).
// Hash format: scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>.

export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, saltBytes: 16, keyBytes: 64 });
export const MAX_CONCURRENT_HASHES = 2;
export const TOKEN_BYTES = 32;

// At most MAX_CONCURRENT_HASHES scrypt runs at a time in this process; the
// rest wait in order. A finished run hands its slot straight to the next
// waiter, so the limit holds even between ticks.
const hashSlots = { active: 0, maxActive: 0, runs: 0, waiting: [] };

async function withHashSlot(task) {
  if (hashSlots.active >= MAX_CONCURRENT_HASHES) {
    await new Promise((resolve) => hashSlots.waiting.push(resolve));
  } else {
    hashSlots.active += 1;
  }

  hashSlots.maxActive = Math.max(hashSlots.maxActive, hashSlots.active);

  try {
    return await task();
  } finally {
    const next = hashSlots.waiting.shift();

    if (next) {
      next();
    } else {
      hashSlots.active -= 1;
    }
  }
}

// For fixtures: how many scrypt runs happened and the most at once.
export function getHashStats() {
  return { active: hashSlots.active, maxActive: hashSlots.maxActive, runs: hashSlots.runs, waiting: hashSlots.waiting.length };
}

export function resetHashStats() {
  hashSlots.maxActive = hashSlots.active;
  hashSlots.runs = 0;
}

function runScrypt(secret, salt, params) {
  return withHashSlot(
    () =>
      new Promise((resolve, reject) => {
        hashSlots.runs += 1;
        scrypt(
          Buffer.from(secret, "utf8"),
          salt,
          params.keyBytes,
          { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      }),
  );
}

export async function hashSecret(secret) {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const key = await runScrypt(secret, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function parseHash(stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];

  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }

  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");

  if (![N, r, p].every(Number.isSafeInteger) || !salt.length || !key.length) {
    return null;
  }

  return { params: { N, r, p, keyBytes: key.length }, salt, key };
}

let dummyHashPromise = null;

// A hash nobody knows the secret of: checking against it costs the same as a
// real check, so an unknown username takes as long as a wrong password.
function getDummyHash() {
  dummyHashPromise ??= hashSecret(randomBytes(32).toString("base64url"));
  return dummyHashPromise;
}

// Resolves true when secret matches stored. When stored is null (unknown
// user) scrypt still runs against a dummy hash and the answer is false.
export async function verifySecret(secret, stored) {
  const parsed = stored ? parseHash(stored) : null;
  const target = parsed ?? parseHash(await getDummyHash());
  const key = await runScrypt(String(secret), target.salt, target.params);
  const matches = key.length === target.key.length && timingSafeEqual(key, target.key);
  return parsed !== null && matches;
}

// Compares two strings in constant time for their length (both are hashed
// first, so different lengths compare as fast as equal ones).
export function safeEqualText(left, right) {
  const a = createHash("sha256").update(String(left), "utf8").digest();
  const b = createHash("sha256").update(String(right), "utf8").digest();
  return timingSafeEqual(a, b);
}

// Recovery codes: 20 characters from an alphabet without look-alikes, shown
// as five groups of four. Input is normalised (case, spaces, dashes) first.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const RECOVERY_CODE_LENGTH = 20;

export function createRecoveryCode() {
  let raw = "";

  for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) {
    raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }

  return raw.match(/.{4}/g).join("-");
}

export function normalizeRecoveryCode(code) {
  if (typeof code !== "string" || code.length > 100) {
    return null;
  }

  const raw = code.toUpperCase().replace(/[\s-]/g, "");
  return raw.length === RECOVERY_CODE_LENGTH && [...raw].every((char) => RECOVERY_ALPHABET.includes(char)) ? raw : null;
}

export function createToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function createUserId() {
  return `u_${randomBytes(16).toString("base64url")}`;
}
