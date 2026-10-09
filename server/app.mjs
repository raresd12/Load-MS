import { isSyncableCollection, SYNCABLE_COLLECTIONS } from "./collections.mjs";
import { canonicalJson, DELETED_HASH, sha256Hex } from "./canonical.mjs";
import { getEpoch, transaction } from "./db.mjs";
import { createRateLimiter } from "./rateLimit.mjs";
import {
  createRecoveryCode,
  createToken,
  createUserId,
  hashSecret,
  hashToken,
  normalizeRecoveryCode,
  safeEqualText,
  verifySecret,
} from "./secrets.mjs";

// The Load MS sync API (decisions H6-1 to H6-6, H6-12). Everything a request
// can reach - routing, CORS, limits, JSON parsing, auth - sits behind
// fetch(Request) -> Response, so fixtures and the client's integration test
// call it without sockets; server/index.mjs only adapts node:http to it.

export const SERVER_VERSION = "1.0.0";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_LIMITS = Object.freeze({
  // Only an authenticated push may send this much; every other route that
  // takes a body is capped at authRequestBytes (decision H6-29).
  requestBytes: 4 * 1024 * 1024,
  authRequestBytes: 16 * 1024,
  bodyBytes: 512 * 1024,
  userBytes: 25 * 1024 * 1024,
  userRecords: 50_000,
  opsPerPush: 200,
  pullLimit: 500,
  // A pull page also stops once its bodies pass this size (at least one
  // record per page), so a page never holds a whole 25 MB account.
  pullBytes: 4 * 1024 * 1024,
  // The server bodies one push answer carries back with its conflicts. Past
  // it (always at least one body), a conflict comes back without its body and
  // with bodyOmitted: true, and each record's body is sent at most once per
  // answer (decision H6-43).
  pushConflictBytes: 4 * 1024 * 1024,
  tokenTtlMs: 180 * DAY,
  tokenTouchMs: HOUR,
  appliedOpsTtlMs: 90 * DAY,
  // The op log keeps at most this many results per user; the oldest go first
  // (decision H6-32). A retry older than that converges by content hash.
  appliedOpsPerUser: 10_000,
  maintenanceEveryMs: HOUR,
});

export const DEFAULT_RATE_LIMITS = Object.freeze({
  auth: Object.freeze([
    Object.freeze({ windowMs: MINUTE, max: 10 }),
    Object.freeze({ windowMs: HOUR, max: 60 }),
  ]),
  signup: Object.freeze([Object.freeze({ windowMs: HOUR, max: 5 })]),
  sync: Object.freeze([Object.freeze({ windowMs: MINUTE, max: 120 })]),
});

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "authorization, content-type";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const MESSAGES = Object.freeze({
  invalid_credentials: "Wrong username or password.",
  invalid_recovery: "Wrong username or recovery code.",
  unauthorized: "Sign in again to continue.",
  wrong_password: "The password is not correct.",
  invalid_username: "Use 3-32 characters: a-z, 0-9, dot, underscore or dash.",
  invalid_password: `Use a password of ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`,
  invalid_invite: "That invite code is not valid.",
  signup_closed: "Sign-up is closed on this server.",
  username_taken: "That username is taken.",
  invalid_request: "The request is not valid.",
  invalid_json: "The request body is not valid JSON.",
  unsupported_media_type: "Send the request body as application/json.",
  payload_too_large: "The request is too large.",
  too_many_ops: "Too many changes in one request.",
  origin_not_allowed: "This origin may not use the API.",
  rate_limited: "Too many requests. Try again later.",
  not_found: "Not found.",
  method_not_allowed: "Method not allowed.",
  epoch_changed: "The sync server was restored from a backup. Link this device again.",
  busy: "The server is busy. Try again in a moment.",
  internal: "Something went wrong on the server.",
  unavailable: "The server is shutting down.",
});

export class ApiError extends Error {
  constructor(status, code, { message, headers } = {}) {
    super(message ?? MESSAGES[code] ?? code);
    this.status = status;
    this.code = code;
    this.headers = headers ?? {};
  }
}

function utf8Length(text) {
  return Buffer.byteLength(text, "utf8");
}

function normalizeUsername(value) {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }

  const username = value.toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

function isValidPassword(value) {
  if (typeof value !== "string") {
    return false;
  }

  const length = Array.from(value).length;
  return length >= PASSWORD_MIN && length <= PASSWORD_MAX;
}

// The text a password is hashed as (NFC, so the same typed password matches
// on every device). Not a string, or absurdly long: a value nobody has.
function passwordText(value) {
  return typeof value === "string" && value.length <= 4 * PASSWORD_MAX ? value.normalize("NFC") : "";
}

// JSON.parse turns every { and [ into an object; a body made of nothing else
// costs far more memory than its size. Real records use about one per 64
// bytes, so this leaves a wide margin (decision H6-29).
export function maxJsonContainers(bytes) {
  return Math.floor(bytes / 16) + 256;
}

function countJsonContainers(text) {
  let count = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === 123 || code === 91) {
      count += 1;
    }
  }

  return count;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readBody(request, maxBytes) {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number(declared) > maxBytes) {
    throw new ApiError(413, "payload_too_large");
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, "payload_too_large");
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString("utf8");
}

async function readJson(request, maxBytes) {
  const text = await readBody(request, maxBytes);

  if (!text.length) {
    return {};
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  if (type !== "application/json") {
    throw new ApiError(415, "unsupported_media_type");
  }

  if (countJsonContainers(text) > maxJsonContainers(utf8Length(text))) {
    throw new ApiError(413, "payload_too_large");
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_request");
  }

  return parsed;
}

/**
 * createApi({ db, config, clock }) -> { fetch(request, info?), gate(head, info?),
 *   errorResponse(headers, status, code, extraHeaders?), close() }
 * config: { allowedOrigins?: string[], signupCode?: string | null,
 *   maxAccounts?: number, version?: string, limits?: Partial<DEFAULT_LIMITS>,
 *   rateLimits?: Partial<DEFAULT_RATE_LIMITS>, onError?: (error) => void }
 * info: { ip?: string } - the client address the rate limits key on.
 * gate({ method, url, headers }) answers before any body is read (decision
 * H6-29): { response } when the request is refused (origin, route, token, rate
 * limit), else { maxBytes, pool, key } - the most body bytes the route
 * accepts, and whose in-flight budget its body is buffered under (decision
 * H6-44): pool "user" with the token's user id for a route that needs a
 * token, else pool "anon" with the client address.
 */
export function createApi({ db, config = {}, clock = () => Date.now() }) {
  if (!db) {
    throw new TypeError("createApi needs a database (server/db.mjs openDatabase).");
  }

  const limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) };
  const rateLimits = { ...DEFAULT_RATE_LIMITS, ...(config.rateLimits ?? {}) };
  const allowedOrigins = new Set((config.allowedOrigins ?? []).filter(Boolean));
  const signupCode = typeof config.signupCode === "string" && config.signupCode ? config.signupCode : null;
  const maxAccounts = Number.isSafeInteger(config.maxAccounts) && config.maxAccounts >= 0 ? config.maxAccounts : 50;
  const version = config.version ?? SERVER_VERSION;
  const onError = typeof config.onError === "function" ? config.onError : (error) => console.error("loadms-api error:", error);
  const limiter = createRateLimiter({ clock });
  let closed = false;
  let lastMaintenance = -Infinity;

  const sql = {
    userByName: db.prepare("SELECT id, username, password_hash, recovery_hash FROM users WHERE username = ?"),
    userById: db.prepare("SELECT id, username, password_hash FROM users WHERE id = ?"),
    tokenExists: db.prepare("SELECT 1 AS ok FROM tokens WHERE hash = ? AND user_id = ?"),
    countUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
    insertUser: db.prepare(
      "INSERT INTO users (id, username, password_hash, recovery_hash, created_at, seq) VALUES (?, ?, ?, ?, ?, 0)",
    ),
    setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
    recoverUser: db.prepare(
      "UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ? AND recovery_hash = ?",
    ),
    nextSeq: db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    insertToken: db.prepare(
      "INSERT INTO tokens (hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ),
    tokenLookup: db.prepare(
      "SELECT t.hash, t.user_id, t.last_used_at, t.expires_at, u.username FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?",
    ),
    touchToken: db.prepare("UPDATE tokens SET last_used_at = ?, expires_at = ? WHERE hash = ?"),
    deleteToken: db.prepare("DELETE FROM tokens WHERE hash = ? AND user_id = ?"),
    deleteUserTokens: db.prepare("DELETE FROM tokens WHERE user_id = ?"),
    deleteOtherTokens: db.prepare("DELETE FROM tokens WHERE user_id = ? AND hash <> ?"),
    deleteExpiredTokens: db.prepare("DELETE FROM tokens WHERE expires_at <= ?"),
    usage: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM records WHERE user_id = ?"),
    liveByCollection: db.prepare(
      "SELECT collection, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM records WHERE user_id = ? AND deleted = 0 GROUP BY collection",
    ),
    // The body is read only when an answer sends it (decision H6-43).
    record: db.prepare(
      "SELECT rev, seq, deleted, hash, size FROM records WHERE user_id = ? AND collection = ? AND record_id = ?",
    ),
    recordBody: db.prepare("SELECT body FROM records WHERE user_id = ? AND collection = ? AND record_id = ?"),
    upsertRecord: db.prepare(
      `INSERT INTO records (user_id, collection, record_id, rev, seq, deleted, body, hash, size, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, collection, record_id) DO UPDATE SET
         rev = excluded.rev, seq = excluded.seq, deleted = excluded.deleted, body = excluded.body,
         hash = excluded.hash, size = excluded.size, updated_at = excluded.updated_at, device_id = excluded.device_id`,
    ),
    // A pull first reads only positions and sizes, then the bodies of the
    // records the page returns (decision H6-33).
    pullHeads: db.prepare("SELECT seq, size FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?"),
    pullRange: db.prepare(
      "SELECT collection, record_id, rev, seq, deleted, body FROM records WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq",
    ),
    deleteUserRecords: db.prepare("DELETE FROM records WHERE user_id = ?"),
    appliedOp: db.prepare("SELECT result FROM applied_ops WHERE user_id = ? AND op_id = ?"),
    insertAppliedOp: db.prepare("INSERT INTO applied_ops (user_id, op_id, result, created_at) VALUES (?, ?, ?, ?)"),
    deleteUserOps: db.prepare("DELETE FROM applied_ops WHERE user_id = ?"),
    deleteOldOps: db.prepare("DELETE FROM applied_ops WHERE created_at < ?"),
    countUserOps: db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?"),
    pruneUserOps: db.prepare(
      "DELETE FROM applied_ops WHERE rowid IN (SELECT rowid FROM applied_ops WHERE user_id = ? ORDER BY created_at, rowid LIMIT ?)",
    ),
    ping: db.prepare("SELECT 1 AS ok"),
  };

  function maintain(now) {
    if (now - lastMaintenance < limits.maintenanceEveryMs) {
      return;
    }

    lastMaintenance = now;
    sql.deleteOldOps.run(now - limits.appliedOpsTtlMs);
    sql.deleteExpiredTokens.run(now);
  }

  function rateLimited(result) {
    return new ApiError(429, "rate_limited", { headers: { "retry-after": String(result.retryAfterSeconds) } });
  }

  // limit(bucket, key, bucket2, key2, ...): every bucket is asked first and
  // only then recorded, so a request one bucket refuses never uses up another
  // (decision H6-29).
  function limit(...pairs) {
    for (let index = 0; index < pairs.length; index += 2) {
      peekLimit(pairs[index], pairs[index + 1]);
    }

    for (let index = 0; index < pairs.length; index += 2) {
      const result = limiter.hit(`${pairs[index]}:${pairs[index + 1]}`, rateLimits[pairs[index]]);

      if (!result.ok) {
        throw rateLimited(result);
      }
    }
  }

  function peekLimit(bucket, key) {
    const result = limiter.check(`${bucket}:${key}`, rateLimits[bucket]);

    if (!result.ok) {
      throw rateLimited(result);
    }
  }

  function issueToken(userId, now) {
    const token = createToken();
    sql.insertToken.run(hashToken(token), userId, now, now, now + limits.tokenTtlMs);
    return token;
  }

  function authenticate(request, { touch = true } = {}) {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header.trim());

    if (!match) {
      throw new ApiError(401, "unauthorized");
    }

    const now = clock();
    const tokenHash = hashToken(match[1]);
    const row = sql.tokenLookup.get(tokenHash);

    if (!row || row.expires_at <= now) {
      throw new ApiError(401, "unauthorized");
    }

    // Last use is written at most once an hour; the token then lives
    // tokenTtlMs after that use (decision H6-3).
    if (touch && now - row.last_used_at >= limits.tokenTouchMs) {
      sql.touchToken.run(now, now + limits.tokenTtlMs, tokenHash);
    }

    return { userId: row.user_id, username: row.username, tokenHash };
  }

  function publicUser(row) {
    return { id: row.id, username: row.username };
  }

  // ---- auth ---------------------------------------------------------------

  async function signup(request, ip) {
    limit("auth", ip, "signup", ip);
    const body = await readJson(request, limits.authRequestBytes);
    const username = normalizeUsername(body.username);

    if (!username) {
      throw new ApiError(400, "invalid_username");
    }

    if (!isValidPassword(body.password)) {
      throw new ApiError(400, "invalid_password");
    }

    if (signupCode && (typeof body.inviteCode !== "string" || !safeEqualText(body.inviteCode.trim(), signupCode))) {
      throw new ApiError(403, "invalid_invite");
    }

    if (sql.countUsers.get().n >= maxAccounts) {
      throw new ApiError(403, "signup_closed");
    }

    if (sql.userByName.get(username)) {
      throw new ApiError(409, "username_taken");
    }

    const recoveryCode = createRecoveryCode();
    const passwordHash = await hashSecret(passwordText(body.password));
    const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode));
    const now = clock();
    const userId = createUserId();

    // Checked again inside the write: another sign-up may have finished while
    // this one was hashing.
    const token = transaction(db, () => {
      if (sql.countUsers.get().n >= maxAccounts) {
        throw new ApiError(403, "signup_closed");
      }

      if (sql.userByName.get(username)) {
        throw new ApiError(409, "username_taken");
      }

      sql.insertUser.run(userId, username, passwordHash, recoveryHash, now);
      return issueToken(userId, now);
    });

    return json(201, { token, user: { id: userId, username }, recoveryCode });
  }

  async function signin(request, ip) {
    limit("auth", ip);
    const body = await readJson(request, limits.authRequestBytes);
    const username = normalizeUsername(body.username);
    const user = username ? sql.userByName.get(username) : undefined;
    // scrypt runs whether or not the user exists (a dummy hash otherwise).
    const ok = await verifySecret(passwordText(body.password), user?.password_hash ?? null);

    if (!ok || !user) {
      throw new ApiError(401, "invalid_credentials");
    }

    // The password may have changed while scrypt ran: a token is only issued
    // for the password that is still current (decision H6-30).
    const token = transaction(db, () => {
      const current = sql.userById.get(user.id);

      if (!current || current.password_hash !== user.password_hash) {
        throw new ApiError(401, "invalid_credentials");
      }

      return issueToken(user.id, clock());
    });
    return json(200, { token, user: publicUser(user) });
  }

  async function signout(request, ip) {
    limit("auth", ip);
    const auth = authenticate(request);
    sql.deleteToken.run(auth.tokenHash, auth.userId);
    return json(200, { ok: true });
  }

  async function signoutAll(request, ip) {
    limit("auth", ip);
    const auth = authenticate(request);
    const { changes } = sql.deleteUserTokens.run(auth.userId);
    return json(200, { ok: true, revoked: Number(changes) });
  }

  async function recover(request, ip) {
    limit("auth", ip);
    const body = await readJson(request, limits.authRequestBytes);

    if (!isValidPassword(body.newPassword)) {
      throw new ApiError(400, "invalid_password");
    }

    const username = normalizeUsername(body.username);
    const user = username ? sql.userByName.get(username) : undefined;
    const code = normalizeRecoveryCode(body.recoveryCode);
    const ok = await verifySecret(code ?? "", code ? (user?.recovery_hash ?? null) : null);

    if (!ok || !user || !code) {
      throw new ApiError(401, "invalid_recovery");
    }

    const recoveryCode = createRecoveryCode();
    const passwordHash = await hashSecret(passwordText(body.newPassword));
    const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode));
    const now = clock();

    const token = transaction(db, () => {
      // The code is single use: a second recovery racing this one finds the
      // hash already replaced and fails.
      const { changes } = sql.recoverUser.run(passwordHash, recoveryHash, user.id, user.recovery_hash);

      if (Number(changes) !== 1) {
        throw new ApiError(401, "invalid_recovery");
      }

      sql.deleteUserTokens.run(user.id);
      return issueToken(user.id, now);
    });

    return json(200, { token, user: publicUser(user), recoveryCode });
  }

  async function changePassword(request, ip) {
    limit("auth", ip);
    const auth = authenticate(request);
    const body = await readJson(request, limits.authRequestBytes);

    if (!isValidPassword(body.newPassword)) {
      throw new ApiError(400, "invalid_password");
    }

    const user = sql.userById.get(auth.userId);
    const ok = await verifySecret(passwordText(body.currentPassword), user?.password_hash ?? null);

    if (!ok || !user) {
      throw new ApiError(403, "wrong_password");
    }

    const passwordHash = await hashSecret(passwordText(body.newPassword));
    const revoked = transaction(db, () => {
      // Checked again after the hashing (decision H6-30): the session must
      // still exist and the password must be the one that was verified.
      assertStillCurrent(auth, user);
      sql.setPassword.run(passwordHash, auth.userId);
      return Number(sql.deleteOtherTokens.run(auth.userId, auth.tokenHash).changes);
    });

    return json(200, { ok: true, revoked });
  }

  function assertStillCurrent(auth, user) {
    if (!sql.tokenExists.get(auth.tokenHash, auth.userId)) {
      throw new ApiError(401, "unauthorized");
    }

    const current = sql.userById.get(auth.userId);

    if (!current || current.password_hash !== user.password_hash) {
      throw new ApiError(403, "wrong_password");
    }
  }

  // ---- account ------------------------------------------------------------

  async function account(request) {
    const auth = authenticate(request);
    limit("sync", auth.userId);
    const collections = Object.fromEntries(SYNCABLE_COLLECTIONS.map((name) => [name, 0]));
    let records = 0;
    let bytes = 0;

    for (const row of sql.liveByCollection.all(auth.userId)) {
      collections[row.collection] = Number(row.n);
      records += Number(row.n);
      bytes += Number(row.bytes);
    }

    return json(200, { user: { id: auth.userId, username: auth.username }, stats: { records, bytes, collections } });
  }

  async function deleteAccount(request, ip) {
    limit("auth", ip);
    const auth = authenticate(request);
    const body = await readJson(request, limits.authRequestBytes);
    const user = sql.userById.get(auth.userId);
    const ok = await verifySecret(passwordText(body.password), user?.password_hash ?? null);

    if (!ok || !user) {
      throw new ApiError(403, "wrong_password");
    }

    transaction(db, () => {
      assertStillCurrent(auth, user);
      sql.deleteUserRecords.run(auth.userId);
      sql.deleteUserOps.run(auth.userId);
      sql.deleteUserTokens.run(auth.userId);
      sql.deleteUser.run(auth.userId);
    });

    return json(200, { ok: true });
  }

  // ---- sync ---------------------------------------------------------------

  function validateOp(op) {
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      return { code: "invalid_op" };
    }

    if (typeof op.opId !== "string" || op.opId.length < 8 || op.opId.length > 200) {
      return { code: "invalid_op_id" };
    }

    if (!isSyncableCollection(op.collection)) {
      return { code: "invalid_collection" };
    }

    if (typeof op.recordId !== "string" || op.recordId.length < 1 || op.recordId.length > 300) {
      return { code: "invalid_record_id" };
    }

    if (!isNonNegativeInteger(op.baseRev)) {
      return { code: "invalid_base_rev" };
    }

    if (typeof op.deleted !== "boolean") {
      return { code: "invalid_deleted" };
    }

    if (op.deleted) {
      return { text: null, size: 0, hash: DELETED_HASH };
    }

    let text;

    try {
      text = op.body === undefined ? undefined : canonicalJson(op.body);
    } catch {
      text = undefined;
    }

    if (text === undefined) {
      return { code: "invalid_body" };
    }

    const size = utf8Length(text);

    if (size > limits.bodyBytes) {
      return { code: "body_too_large" };
    }

    return { text, size, hash: sha256Hex(text) };
  }

  function applyOp(userId, deviceId, op, checked, usage, answer) {
    return transaction(db, () => {
      const stored = sql.appliedOp.get(userId, op.opId);

      if (stored) {
        return JSON.parse(stored.result);
      }

      const current = sql.record.get(userId, op.collection, op.recordId);
      const currentRev = current ? Number(current.rev) : 0;
      // An absent record reads as a tombstone at rev 0 (decision H6-14).
      const currentHash = current ? current.hash : DELETED_HASH;
      let result;

      if (op.baseRev === currentRev) {
        const sizeDelta = checked.size - (current ? Number(current.size) : 0);

        if ((!current && usage.records + 1 > limits.userRecords) || (sizeDelta > 0 && usage.bytes + sizeDelta > limits.userBytes)) {
          return { status: "rejected", code: "quota" };
        }

        const now = clock();
        const seq = Number(sql.nextSeq.get(userId).seq);
        const rev = currentRev + 1;
        sql.upsertRecord.run(
          userId,
          op.collection,
          op.recordId,
          rev,
          seq,
          op.deleted ? 1 : 0,
          checked.text,
          checked.hash,
          checked.size,
          now,
          deviceId,
        );
        usage.records += current ? 0 : 1;
        usage.bytes += sizeDelta;
        result = { status: "applied", rev, seq };
      } else if (currentHash === checked.hash) {
        // Same content already stored: converge without a new revision.
        result = { status: "applied", rev: currentRev, seq: current ? Number(current.seq) : 0 };
      } else {
        // The server keeps its version and sends it back (not stored, so a
        // retry is answered from the current state). The body is spliced in
        // as its stored canonical text, within the answer's byte budget
        // (decision H6-43).
        const live = Boolean(current) && current.deleted !== 1;

        if (!live) {
          return { status: "conflict", rev: currentRev, deleted: true, bodyText: null };
        }

        const size = Number(current.size);
        const key = `${op.collection}${op.recordId}`;

        if (answer.given.has(key) || (answer.given.size > 0 && answer.bytes + size > limits.pushConflictBytes)) {
          return { status: "conflict", rev: currentRev, deleted: false, bodyText: null, bodyOmitted: true };
        }

        answer.given.add(key);
        answer.bytes += size;
        return { status: "conflict", rev: currentRev, deleted: false, bodyText: sql.recordBody.get(userId, op.collection, op.recordId).body };
      }

      sql.insertAppliedOp.run(userId, op.opId, JSON.stringify(result), clock());
      return result;
    });
  }

  async function push(request) {
    const auth = authenticate(request);
    limit("sync", auth.userId);
    const body = await readJson(request, limits.requestBytes);
    const { deviceId, ops } = body;
    const epoch = getEpoch(db);

    if (typeof deviceId !== "string" || deviceId.length < 1 || deviceId.length > 200 || !Array.isArray(ops)) {
      throw new ApiError(400, "invalid_request");
    }

    if (ops.length > limits.opsPerPush) {
      throw new ApiError(400, "too_many_ops");
    }

    // A client that synced against another copy of the database (a restored
    // backup) is told so before anything is applied (decision H6-31).
    if (body.epoch !== undefined && body.epoch !== null && body.epoch !== epoch) {
      throw new ApiError(409, "epoch_changed");
    }

    maintain(clock());
    const usageRow = sql.usage.get(auth.userId);
    const usage = { records: Number(usageRow.n), bytes: Number(usageRow.bytes) };
    const answer = { given: new Set(), bytes: 0 };
    const parts = [];

    for (const op of ops) {
      const opId = op && typeof op.opId === "string" ? op.opId : null;
      const checked = validateOp(op);

      if (checked.code) {
        parts.push(JSON.stringify({ opId, status: "rejected", code: checked.code }));
        continue;
      }

      const { bodyText, ...result } = applyOp(auth.userId, deviceId, op, checked, usage, answer);

      if (result.status !== "conflict") {
        parts.push(JSON.stringify({ opId, ...result }));
        continue;
      }

      // A conflict's server body is spliced in as stored canonical JSON; it
      // is never parsed and stringified again (decision H6-43).
      const head = JSON.stringify({ opId, ...result });
      parts.push(`${head.slice(0, -1)},"body":${bodyText ?? "null"}}`);
    }

    pruneAppliedOps(auth.userId);
    return rawJson(200, `{"results":[${parts.join(",")}],"epoch":${JSON.stringify(epoch)}}`);
  }

  function pruneAppliedOps(userId) {
    const count = Number(sql.countUserOps.get(userId).n);

    if (count > limits.appliedOpsPerUser) {
      sql.pruneUserOps.run(userId, count - limits.appliedOpsPerUser);
    }
  }

  async function pull(request, ip, url) {
    const auth = authenticate(request);
    limit("sync", auth.userId);
    const sinceText = url.searchParams.get("since") ?? "0";
    const limitText = url.searchParams.get("limit") ?? String(limits.pullLimit);

    if (!/^\d{1,15}$/.test(sinceText) || !/^\d{1,4}$/.test(limitText)) {
      throw new ApiError(400, "invalid_request");
    }

    const since = Number(sinceText);
    const pageSize = Number(limitText);

    if (pageSize < 1 || pageSize > limits.pullLimit) {
      throw new ApiError(400, "invalid_request");
    }

    const heads = sql.pullHeads.all(auth.userId, since, pageSize + 1);
    let bytes = 0;
    let count = 0;
    let nextSince = since;
    let more = heads.length > pageSize;

    for (const head of heads.slice(0, pageSize)) {
      if (count && bytes + Number(head.size) > limits.pullBytes) {
        more = true;
        break;
      }

      bytes += Number(head.size);
      nextSince = Number(head.seq);
      count += 1;
    }

    // Only the bodies of this page are read. Seqs only grow, and nothing runs
    // between the two reads (DatabaseSync is synchronous).
    const rows = count ? sql.pullRange.all(auth.userId, since, nextSince) : [];
    const parts = [];

    for (const row of rows) {
      // Bodies are stored as canonical JSON text and spliced in as they are.
      parts.push(
        `{"collection":${JSON.stringify(row.collection)},"recordId":${JSON.stringify(row.record_id)},"rev":${Number(row.rev)},"seq":${Number(row.seq)},"deleted":${row.deleted === 1},"body":${row.deleted === 1 || row.body === null ? "null" : row.body}}`,
      );
    }

    return rawJson(
      200,
      `{"records":[${parts.join(",")}],"nextSince":${nextSince},"more":${more},"epoch":${JSON.stringify(getEpoch(db))}}`,
    );
  }

  async function health() {
    sql.ping.get();
    return json(200, { ok: true, version });
  }

  // Route table (decision H6-29): what each route needs before its body is
  // read - a token, the rate-limit buckets it uses, and how many body bytes it
  // accepts. gate() and handle() both read it.
  const AUTH = limits.authRequestBytes;
  const routes = new Map([
    ["GET /v1/health", { handler: health, maxBytes: 0 }],
    ["POST /v1/auth/signup", { handler: signup, ipBuckets: ["auth", "signup"], maxBytes: AUTH }],
    ["POST /v1/auth/signin", { handler: signin, ipBuckets: ["auth"], maxBytes: AUTH }],
    ["POST /v1/auth/signout", { handler: signout, ipBuckets: ["auth"], token: true, maxBytes: AUTH }],
    ["POST /v1/auth/signout-all", { handler: signoutAll, ipBuckets: ["auth"], token: true, maxBytes: AUTH }],
    ["POST /v1/auth/recover", { handler: recover, ipBuckets: ["auth"], maxBytes: AUTH }],
    ["POST /v1/auth/password", { handler: changePassword, ipBuckets: ["auth"], token: true, maxBytes: AUTH }],
    ["GET /v1/account", { handler: account, token: true, userBuckets: ["sync"], maxBytes: 0 }],
    ["POST /v1/account/delete", { handler: deleteAccount, ipBuckets: ["auth"], token: true, maxBytes: AUTH }],
    ["POST /v1/sync/push", { handler: push, token: true, userBuckets: ["sync"], maxBytes: limits.requestBytes }],
    ["GET /v1/sync/pull", { handler: pull, token: true, userBuckets: ["sync"], maxBytes: 0 }],
  ]);
  const knownPaths = new Set([...routes.keys()].map((key) => key.split(" ")[1]));

  function json(status, data) {
    return rawJson(status, JSON.stringify(data));
  }

  function rawJson(status, text) {
    return { status, text, headers: {} };
  }

  function errorResult(error) {
    return {
      status: error.status,
      text: JSON.stringify({ error: { code: error.code, message: error.message } }),
      headers: error.headers,
    };
  }

  function finish(result, corsOrigin) {
    const headers = new Headers(SECURITY_HEADERS);
    headers.set("vary", "Origin");

    if (result.text !== null) {
      headers.set("content-type", "application/json; charset=utf-8");
    }

    for (const [name, value] of Object.entries(result.headers ?? {})) {
      headers.set(name, value);
    }

    if (corsOrigin) {
      headers.set("access-control-allow-origin", corsOrigin);
      headers.set("access-control-expose-headers", "retry-after");
    }

    return new Response(result.text, { status: result.status, headers });
  }

  function corsOriginOf(headers) {
    const origin = headers?.get?.("origin") ?? null;
    return origin && allowedOrigins.has(origin) ? origin : null;
  }

  // Everything that can be decided from the method, URL and headers alone:
  // { response } for an answer, else { route, url, corsOrigin, ip }.
  function resolve(method, rawUrl, headers, info) {
    if (closed) {
      return { response: finish(errorResult(new ApiError(503, "unavailable")), null) };
    }

    let url;

    try {
      url = new URL(rawUrl);
    } catch {
      return { response: finish(errorResult(new ApiError(400, "invalid_request")), null) };
    }

    const origin = headers.get("origin");
    const corsOrigin = corsOriginOf(headers);
    const ip = typeof info?.ip === "string" && info.ip ? info.ip : "unknown";

    if (origin && !corsOrigin) {
      return { response: finish(errorResult(new ApiError(403, "origin_not_allowed")), null) };
    }

    if (method === "OPTIONS") {
      return {
        response: finish(
          {
            status: 204,
            text: null,
            headers: corsOrigin
              ? {
                  "access-control-allow-methods": ALLOWED_METHODS,
                  "access-control-allow-headers": ALLOWED_HEADERS,
                  "access-control-max-age": "600",
                }
              : {},
          },
          corsOrigin,
        ),
      };
    }

    const route = routes.get(`${method} ${url.pathname}`);

    if (!route) {
      const error = knownPaths.has(url.pathname)
        ? new ApiError(405, "method_not_allowed", { headers: { allow: ALLOWED_METHODS } })
        : new ApiError(404, "not_found");
      return { response: finish(errorResult(error), corsOrigin) };
    }

    return { route, url, corsOrigin, ip };
  }

  function gate(head, info) {
    const headers = head?.headers instanceof Headers ? head.headers : new Headers(head?.headers ?? {});
    const resolved = resolve(String(head?.method ?? "GET"), String(head?.url ?? ""), headers, info);

    if (resolved.response) {
      return { response: resolved.response };
    }

    const { route, corsOrigin, ip } = resolved;
    let owner = { pool: "anon", key: ip };

    try {
      for (const bucket of route.ipBuckets ?? []) {
        peekLimit(bucket, ip);
      }

      if (route.token) {
        const auth = authenticate({ headers }, { touch: false });

        for (const bucket of route.userBuckets ?? []) {
          peekLimit(bucket, auth.userId);
        }

        owner = { pool: "user", key: auth.userId };
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return { response: finish(errorResult(error), corsOrigin) };
      }

      onError(error);
      return { response: finish(errorResult(new ApiError(500, "internal")), corsOrigin) };
    }

    return { maxBytes: route.maxBytes, ...owner };
  }

  async function handle(request, info) {
    const resolved = resolve(request.method, request.url, request.headers, info);

    if (resolved.response) {
      return resolved.response;
    }

    const { route, url, corsOrigin, ip } = resolved;

    try {
      // Every handler is called as handler(request, ip, url).
      return finish(await route.handler(request, ip, url), corsOrigin);
    } catch (error) {
      if (error instanceof ApiError) {
        return finish(errorResult(error), corsOrigin);
      }

      onError(error);
      return finish(errorResult(new ApiError(500, "internal")), corsOrigin);
    }
  }

  return {
    fetch: (request, info = {}) => handle(request, info),
    gate: (head, info = {}) => gate(head, info),
    /** A refusal the HTTP wrapper makes itself, with the same CORS and security headers. */
    errorResponse(headers, status, code, extraHeaders = {}) {
      const list = headers instanceof Headers ? headers : new Headers(headers ?? {});
      const origin = list.get("origin");
      const corsOrigin = corsOriginOf(list);
      return finish(errorResult(new ApiError(status, code, { headers: extraHeaders })), origin && !corsOrigin ? null : corsOrigin);
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
