import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApi, DEFAULT_LIMITS, maxJsonContainers } from "../server/app.mjs";
import { createBackup, stampNewEpoch } from "../server/backup.mjs";
import { getEpoch, getSchemaVersion, openDatabase, SCHEMA_VERSION } from "../server/db.mjs";
import { createRateLimiter } from "../server/rateLimit.mjs";
import { createHttpHandler, readConfig } from "../server/index.mjs";

// H6 review round 1, server side (decisions H6-29 to H6-33, H6-41):
// - no body is read before the origin, route, token and rate limit pass, the
//   account routes take 16 KB, a JSON body made of brackets is refused before
//   JSON.parse, and all buffered bodies together stay under a budget;
// - the wrapper's own 413 / 503 carry the CORS and security headers;
// - a refused sign-up never uses up the sign-in bucket;
// - a password change leaves no token issued for the old password, however
//   the sign-ins interleave;
// - the database epoch changes on every backup copy and on --rotate-epoch,
//   and a push from another epoch is refused before anything is applied;
// - the op log keeps at most appliedOpsPerUser rows per user;
// - a pull reads only the bodies of the page it returns;
// - the example invite code is refused at start-up.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://loadms-round1.example";
const START = Date.UTC(2026, 9, 8, 8, 0, 0);
const OPEN_LIMITS = {
  auth: [{ windowMs: 60_000, max: 10_000 }],
  signup: [{ windowMs: 3_600_000, max: 10_000 }],
  sync: [{ windowMs: 60_000, max: 10_000 }],
};

function secret(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function setup({ config = {}, db = openDatabase(":memory:") } = {}) {
  const state = { now: START };
  const api = createApi({ db, config: { allowedOrigins: [ORIGIN], ...config }, clock: () => state.now });

  async function call(method, route, { body, rawBody, token, ip = "10.1.0.1", headers = {} } = {}) {
    const init = { method, headers: { ...headers } };

    if (body !== undefined || rawBody !== undefined) {
      init.headers["content-type"] ??= "application/json";
      init.body = rawBody ?? JSON.stringify(body);
    }

    if (token) {
      init.headers.authorization = `Bearer ${token}`;
    }

    const response = await api.fetch(new Request(`http://api.test${route}`, init), { ip });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  return { state, db, api, call };
}

function op(opId, collection, recordId, baseRev, body, deleted = false) {
  return { opId, collection, recordId, baseRev, deleted, body: deleted ? null : body };
}

// ---- 1. rate limiter: check() never records ------------------------------------------------------
{
  let now = 0;
  const limiter = createRateLimiter({ clock: () => now });
  const rules = [{ windowMs: 1000, max: 2 }];
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.check("k", rules).ok, true, "a check is never recorded");
  }
  assert.equal(limiter.size(), 0, "a check on an unknown key creates no entry");
  assert.equal(limiter.hit("k", rules).ok, true);
  assert.equal(limiter.hit("k", rules).ok, true);
  assert.equal(limiter.check("k", rules).ok, false);
  now = 1000;
  assert.equal(limiter.check("k", rules).ok, true);
}

// ---- 2. a refused sign-up does not use up the sign-in bucket -------------------------------------
{
  const { call } = setup({ config: { signupCode: null } });
  const ip = "10.2.0.1";
  for (let index = 0; index < 5; index += 1) {
    const result = await call("POST", "/v1/auth/signup", { ip, body: { username: `round1-u${index}`, password: secret("pw") } });
    assert.equal(result.status, 201, "five sign-ups an hour are accepted");
  }
  for (let index = 0; index < 5; index += 1) {
    const result = await call("POST", "/v1/auth/signup", { ip, body: { username: `round1-x${index}`, password: secret("pw") } });
    assert.equal(result.status, 429, "the sixth sign-up in an hour is refused");
  }
  const signin = await call("POST", "/v1/auth/signin", { ip, body: { username: "round1-u0", password: "wrong-password-1" } });
  assert.equal(signin.status, 401, "refused sign-ups did not spend the auth bucket: the sign-in is checked, not rate limited");
}

// ---- 3. body caps, the JSON container cap and the gate (in process) --------------------------------
{
  const { api, call } = setup({ config: { rateLimits: OPEN_LIMITS } });
  assert.equal(DEFAULT_LIMITS.authRequestBytes, 16 * 1024);
  assert.equal(DEFAULT_LIMITS.requestBytes, 4 * 1024 * 1024);
  const bigSignin = await call("POST", "/v1/auth/signin", {
    rawBody: JSON.stringify({ username: "someone", password: "p".repeat(20 * 1024) }),
  });
  assert.equal(bigSignin.status, 413, "an account route takes at most 16 KB");

  const user = await call("POST", "/v1/auth/signup", { body: { username: "bomb-user", password: secret("pw") } });
  const token = user.body.token;
  const brackets = 64 * 1024;
  const bomb = `{"deviceId":"d","ops":[],"pad":${"[".repeat(brackets)}${"]".repeat(brackets)}}`;
  assert.ok(bomb.length < DEFAULT_LIMITS.requestBytes);
  assert.ok(brackets > maxJsonContainers(bomb.length));
  const bombed = await call("POST", "/v1/sync/push", { token, rawBody: bomb });
  assert.equal(bombed.status, 413, "a body made of brackets is refused before JSON.parse");
  const flat = await call("POST", "/v1/sync/push", {
    token,
    body: { deviceId: "d", ops: Array.from({ length: 200 }, (_, index) => op(`op-flat-${index}`, "sessions", `f${index}`, 0, { id: `f${index}`, sets: [{ weight: 80, reps: 5, rpe: 8 }, { weight: 80, reps: 5, rpe: 8.5 }] })) },
  });
  assert.equal(flat.status, 200, "a real push is far under the container cap");

  // gate(): decided from the method, URL and headers alone.
  const head = (method, route, headers = {}) => api.gate({ method, url: `http://api.test${route}`, headers: new Headers(headers) }, { ip: "10.3.0.1" });
  assert.equal(head("POST", "/v1/sync/push").response.status, 401, "no token: refused before the body");
  assert.equal(head("POST", "/v1/sync/push", { authorization: "Bearer not-a-real-token-aaaaaaaaaaaa" }).response.status, 401);
  assert.equal(head("POST", "/v1/sync/push", { authorization: `Bearer ${token}`, origin: "https://evil.example" }).response.status, 403);
  assert.equal(head("POST", "/v1/nope").response.status, 404);
  assert.equal(head("PUT", "/v1/sync/push").response.status, 405);
  assert.equal(head("OPTIONS", "/v1/sync/push", { origin: ORIGIN }).response.status, 204);
  const userId = user.body.user.id;
  assert.deepEqual(head("POST", "/v1/sync/push", { authorization: `Bearer ${token}` }), { maxBytes: DEFAULT_LIMITS.requestBytes, pool: "user", key: userId });
  assert.deepEqual(head("POST", "/v1/auth/signin"), { maxBytes: DEFAULT_LIMITS.authRequestBytes, pool: "anon", key: "10.3.0.1" });
  assert.deepEqual(head("POST", "/v1/auth/password", { authorization: `Bearer ${token}` }), { maxBytes: DEFAULT_LIMITS.authRequestBytes, pool: "user", key: userId });

  const refusal = api.errorResponse(new Headers({ origin: ORIGIN }), 413, "payload_too_large");
  assert.equal(refusal.status, 413);
  assert.equal(refusal.headers.get("access-control-allow-origin"), ORIGIN, "the browser can read a 413");
  assert.equal(refusal.headers.get("x-frame-options"), "DENY");
}

{
  // The gate peeks at the rate limit without spending it.
  const { api, call } = setup({ config: { rateLimits: { ...OPEN_LIMITS, auth: [{ windowMs: 60_000, max: 2 }] } } });
  const ip = "10.4.0.1";
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(api.gate({ method: "POST", url: "http://api.test/v1/auth/signin", headers: new Headers() }, { ip }).maxBytes, 16 * 1024);
  }
  assert.equal((await call("POST", "/v1/auth/signin", { ip, body: { username: "nobody-here", password: "wrong-password-1" } })).status, 401);
  assert.equal((await call("POST", "/v1/auth/signin", { ip, body: { username: "nobody-here", password: "wrong-password-1" } })).status, 401);
  const limited = api.gate({ method: "POST", url: "http://api.test/v1/auth/signin", headers: new Headers() }, { ip });
  assert.equal(limited.response.status, 429, "a spent bucket is refused before the body is read");
  assert.ok(Number(limited.response.headers.get("retry-after")) >= 1);
}

// ---- 4. over HTTP: refusals before the body, CORS on 413, the in-flight budget -------------------------------
{
  const db = openDatabase(":memory:");
  const api = createApi({ db, config: { allowedOrigins: [ORIGIN], rateLimits: OPEN_LIMITS } });
  const server = http.createServer(createHttpHandler(api, { log: () => {}, maxInFlightBytes: 256 * 1024 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  function open({ method = "POST", route, headers = {} }) {
    let resolveAnswer;
    let rejectAnswer;
    const answer = new Promise((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    let answered = false;
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
      answered = true;
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        resolveAnswer({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", (error) => (answered ? null : rejectAnswer(error)));
    req.setTimeout(20_000, () => req.destroy(new Error(`no answer for ${route}`)));
    return { req, answer };
  }

  try {
    const signup = await open({ route: "/v1/auth/signup", headers: { "content-type": "application/json" } });
    signup.req.end(JSON.stringify({ username: "http-round1", password: secret("pw") }));
    const token = (await signup.answer).body.token;

    // An unauthenticated push is answered while its body is still unsent.
    const anonymous = open({ route: "/v1/sync/push", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
    anonymous.req.write(Buffer.alloc(64 * 1024, 32));
    const anonymousAnswer = await anonymous.answer;
    assert.equal(anonymousAnswer.status, 401, "no token: refused before the body is read");
    anonymous.req.destroy();

    // A sign-in body past 16 KB: 413 with the CORS and security headers.
    const big = open({ route: "/v1/auth/signin", headers: { origin: ORIGIN, "content-type": "application/json" } });
    big.req.end(Buffer.alloc(32 * 1024, 32));
    const bigAnswer = await big.answer;
    assert.equal(bigAnswer.status, 413);
    assert.equal(bigAnswer.body.error.code, "payload_too_large");
    assert.equal(bigAnswer.headers["access-control-allow-origin"], ORIGIN, "the wrapper's 413 carries CORS");
    assert.equal(bigAnswer.headers["x-frame-options"], "DENY");
    assert.equal(bigAnswer.headers["strict-transport-security"], "max-age=31536000");

    // Two large pushes at once: the second passes the shared budget and gets 503.
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked", origin: ORIGIN };
    const first = open({ route: "/v1/sync/push", headers: auth });
    first.req.write(`{"deviceId":"d","ops":[],"pad":"${"p".repeat(200 * 1024)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = open({ route: "/v1/sync/push", headers: auth });
    second.req.end(`{"deviceId":"d","ops":[],"pad":"${"q".repeat(100 * 1024)}"}`);
    const secondAnswer = await second.answer;
    assert.equal(secondAnswer.status, 503, "the shared body budget is full");
    assert.equal(secondAnswer.body.error.code, "busy");
    assert.equal(secondAnswer.headers["retry-after"], "5");
    assert.equal(secondAnswer.headers["access-control-allow-origin"], ORIGIN);
    first.req.end('"}');
    assert.equal((await first.answer).status, 200, "the first push still completes");
    const third = open({ route: "/v1/sync/push", headers: auth });
    third.req.end(`{"deviceId":"d","ops":[],"pad":"${"r".repeat(200 * 1024)}"}`);
    assert.equal((await third.answer).status, 200, "the budget is released after each request");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    api.close();
  }
}

// ---- 5. password change vs. sign-ins in flight -----------------------------------------------------------------
{
  const { db, call } = setup({ config: { rateLimits: OPEN_LIMITS } });
  const oldPassword = secret("old");
  const newPassword = secret("new");
  const created = await call("POST", "/v1/auth/signup", { body: { username: "race-user", password: oldPassword } });
  const ownToken = created.body.token;
  const signins = [];
  let changed = null;
  const change = call("POST", "/v1/auth/password", { token: ownToken, body: { currentPassword: oldPassword, newPassword } }).then((result) => {
    changed = result;
    return result;
  });

  // Sign-ins with the old password start every few ms until the change is
  // answered, so some read the old hash before it commits and finish after.
  while (!changed) {
    signins.push(call("POST", "/v1/auth/signin", { body: { username: "race-user", password: oldPassword } }));
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  for (let index = 0; index < 4; index += 1) {
    signins.push(call("POST", "/v1/auth/signin", { body: { username: "race-user", password: oldPassword } }));
  }
  assert.equal((await change).status, 200);
  const answers = await Promise.all(signins);
  assert.ok(signins.length >= 3, "sign-ins overlapped the password change");
  const userId = created.body.user.id;
  const tokens = db.prepare("SELECT hash FROM tokens WHERE user_id = ?").all(userId);
  assert.equal(tokens.length, 1, "only the session that changed the password is left");
  for (const answer of answers.filter((result) => result.status === 200)) {
    assert.equal((await call("GET", "/v1/account", { token: answer.body.token })).status, 401, "no old-password token survives");
  }
  assert.equal((await call("GET", "/v1/account", { token: ownToken })).status, 200);
  assert.equal((await call("POST", "/v1/auth/signin", { body: { username: "race-user", password: newPassword } })).status, 200);

  // A second change racing the first with the same old password loses.
  const again = await Promise.all([
    call("POST", "/v1/auth/password", { token: ownToken, body: { currentPassword: newPassword, newPassword: secret("third") } }),
    call("POST", "/v1/auth/password", { token: ownToken, body: { currentPassword: newPassword, newPassword: secret("fourth") } }),
  ]);
  assert.deepEqual(again.map((result) => result.status).sort(), [200, 403], "one of two racing changes wins");
}

// ---- 6. the database epoch ---------------------------------------------------------------------------------------------
const temp = mkdtempSync(path.join(os.tmpdir(), "loadms-round1-"));
try {
  const dbPath = path.join(temp, "data", "loadms.db");
  const db = openDatabase(dbPath);
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(getSchemaVersion(db), 2);
  const epoch = getEpoch(db);
  assert.match(epoch, /^[0-9a-f]{32}$/);
  const { call } = setup({ db, config: { rateLimits: OPEN_LIMITS } });
  const user = await call("POST", "/v1/auth/signup", { body: { username: "epoch-user", password: secret("pw") } });
  const token = user.body.token;
  const pushed = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d1", epoch, ops: [op("op-epoch-1", "sessions", "s1", 0, { id: "s1" })] } });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.epoch, epoch);
  assert.equal(pushed.body.results[0].status, "applied");
  const pulled = await call("GET", "/v1/sync/pull?since=0", { token });
  assert.equal(pulled.body.epoch, epoch);
  const stale = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d1", epoch: "0".repeat(32), ops: [op("op-epoch-2", "sessions", "s2", 0, { id: "s2" })] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "epoch_changed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE record_id = 's2'").get().n, 0, "nothing from another epoch is applied");
  const legacy = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d1", ops: [] } });
  assert.equal(legacy.status, 200, "a push without an epoch (an older client) is still accepted");

  const backup = createBackup({ dbPath, dir: path.join(temp, "backups"), keep: 3, now: new Date(START) });
  const restored = openDatabase(backup.file);
  assert.notEqual(getEpoch(restored), epoch, "a backup copy never carries the live epoch");
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM records").get().n, 1, "the copy holds the data");
  restored.close();
  assert.equal(getEpoch(db), epoch, "the live database keeps its epoch");

  const before = getEpoch(db);
  const rotated = stampNewEpoch(dbPath);
  assert.notEqual(rotated, before);
  assert.equal(getEpoch(db), rotated);
  db.close();
  const cli = spawnSync(process.execPath, [path.join(root, "server", "backup.mjs"), "--rotate-epoch", dbPath], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const reopened = openDatabase(dbPath);
  assert.notEqual(getEpoch(reopened), rotated, "--rotate-epoch gives a restored database a new epoch");
  reopened.close();
} finally {
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {
    // Windows keeps a file open a moment longer; the directory is temporary.
  }
}

// ---- 7. the op log is capped per user -------------------------------------------------------------------------------------
{
  const cap = 50;
  const { db, call } = setup({ config: { rateLimits: OPEN_LIMITS, limits: { appliedOpsPerUser: cap } } });
  const user = await call("POST", "/v1/auth/signup", { body: { username: "ops-user", password: secret("pw") } });
  const token = user.body.token;
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(user.body.user.id).n;
  for (let batch = 0; batch < 3; batch += 1) {
    const ops = Array.from({ length: 40 }, (_, index) => op(`op-cap-${batch}-${index}`, "setupCues", `c-${batch}-${index}`, 0, { batch, index }));
    const result = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops } });
    assert.ok(result.body.results.every((entry) => entry.status === "applied"));
    assert.ok(count() <= cap, `the op log stays at ${cap} rows (now ${count()})`);
  }
  assert.equal(count(), cap);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = 'op-cap-0-0'").get().n, 0, "the oldest results go first");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = 'op-cap-2-39'").get().n, 1, "the newest are kept");
  const retry = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops: [op("op-cap-0-0", "setupCues", "c-0-0", 0, { batch: 0, index: 0 })] } });
  assert.equal(retry.body.results[0].status, "applied", "a pruned retry still converges by content");
  assert.equal(retry.body.results[0].rev, 1);
}

// ---- 8. a pull reads only the bodies it returns -------------------------------------------------------------------------
{
  const base = openDatabase(":memory:");
  const tally = { bodyBytes: 0 };
  const counted = new Proxy(base, {
    get(target, property) {
      if (property === "prepare") {
        return (text) => {
          const statement = target.prepare(text);
          return new Proxy(statement, {
            get(inner, name) {
              const value = inner[name];
              if (name === "all" || name === "get") {
                return (...args) => {
                  const result = value.apply(inner, args);
                  for (const row of Array.isArray(result) ? result : result ? [result] : []) {
                    if (typeof row.body === "string") {
                      tally.bodyBytes += row.body.length;
                    }
                  }
                  return result;
                };
              }
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pullBytes = 64 * 1024;
  const { call } = setup({ db: counted, config: { rateLimits: OPEN_LIMITS, limits: { pullBytes } } });
  const user = await call("POST", "/v1/auth/signup", { body: { username: "pull-user", password: secret("pw") } });
  const token = user.body.token;
  const record = "x".repeat(40 * 1024);
  for (let batch = 0; batch < 2; batch += 1) {
    const ops = Array.from({ length: 40 }, (_, index) => op(`op-pull-${batch}-${index}`, "sessions", `p-${batch}-${index}`, 0, { note: record, index }));
    await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops } });
  }
  tally.bodyBytes = 0;
  const page = await call("GET", "/v1/sync/pull?since=0&limit=500", { token });
  assert.equal(page.body.records.length, 1, "a 40 KB record per page under a 64 KB page cap");
  assert.equal(page.body.more, true);
  assert.ok(tally.bodyBytes < 2 * 41 * 1024, `the page read ${tally.bodyBytes} body bytes, not all 80 records`);
  let since = 0;
  let total = 0;
  for (;;) {
    const next = await call("GET", `/v1/sync/pull?since=${since}&limit=500`, { token });
    total += next.body.records.length;
    since = next.body.nextSince;
    if (!next.body.more) {
      break;
    }
  }
  assert.equal(total, 80, "every record still arrives, page by page");
}

// ---- 9. the example invite code is refused at start-up ------------------------------------------------------------------
assert.throws(
  () => readConfig({ LOADMS_DB: "x.db", LOADMS_SIGNUP_CODE: "replace-with-a-long-random-invite-code" }, []),
  /placeholder/,
);
assert.equal(readConfig({ LOADMS_DB: "x.db", LOADMS_SIGNUP_CODE: "a-real-code-4711" }, []).signupCode, "a-real-code-4711");

console.log("verify-server-h6-round1: ok");
