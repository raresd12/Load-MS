import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createApi, DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
import { getHashStats, resetHashStats, SCRYPT_PARAMS } from "../server/secrets.mjs";

// H6 Track A: accounts, passwords, recovery codes, tokens and auth limits
// (decisions H6-2, H6-3, H6-12, H6-13). Real createApi on an in-memory
// database; the clock is a variable the script moves. Credentials are random
// per run and never printed.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 7, 8, 0, 0);

function randomSecret(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function setup(config = {}) {
  const state = { now: START };
  const db = openDatabase(":memory:");
  const api = createApi({ db, config, clock: () => state.now });
  let ipCounter = 0;

  async function call(method, path, { body, token, ip, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };

    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    if (token) {
      init.headers.authorization = `Bearer ${token}`;
    }

    // Each call gets its own address unless one is given, so the per-IP auth
    // limits only bite where a check means them to.
    ipCounter += 1;
    const response = await api.fetch(new Request(`http://api.test${path}`, init), { ip: ip ?? `10.9.${ipCounter >> 8}.${ipCounter & 255}` });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  return { state, db, api, call };
}

const { state, db, api, call } = setup();
const aliceName = `Al_${crypto.randomUUID().slice(0, 8)}`;
const alicePassword = randomSecret("pw");

// ---- sign-up validation -----------------------------------------------------
for (const username of ["ab", "has space", "a".repeat(33), "bad/name", "ünï", 42, null]) {
  const result = await call("POST", "/v1/auth/signup", { body: { username, password: alicePassword } });
  assert.equal(result.status, 400, `username ${String(username)} refused`);
  assert.equal(result.body.error.code, "invalid_username");
  assert.equal(typeof result.body.error.message, "string");
}

for (const password of ["short", "123456789", "x".repeat(201), 1234567890, null]) {
  const result = await call("POST", "/v1/auth/signup", { body: { username: "valid.name", password } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "invalid_password");
}

const longPasswordUser = await call("POST", "/v1/auth/signup", {
  body: { username: "long_pw-user.1", password: "p".repeat(200) },
});
assert.equal(longPasswordUser.status, 201, "a 200-character password and every allowed username character are accepted");

// ---- sign-up -----------------------------------------------------------------
const signup = await call("POST", "/v1/auth/signup", { body: { username: aliceName, password: alicePassword } });
assert.equal(signup.status, 201);
assert.deepEqual(Object.keys(signup.body).sort(), ["recoveryCode", "token", "user"]);
assert.equal(signup.body.user.username, aliceName.toLowerCase(), "the username is stored lower-case");
assert.match(signup.body.user.id, /^u_[A-Za-z0-9_-]{22}$/);
assert.match(signup.body.token, /^[A-Za-z0-9_-]{43}$/, "token = 32 random bytes, base64url");
assert.match(signup.body.recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
const aliceId = signup.body.user.id;
let aliceToken = signup.body.token;
let aliceRecovery = signup.body.recoveryCode;

const duplicate = await call("POST", "/v1/auth/signup", { body: { username: aliceName.toUpperCase(), password: alicePassword } });
assert.equal(duplicate.status, 409);
assert.equal(duplicate.body.error.code, "username_taken");

// ---- what the database keeps -------------------------------------------------
const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(aliceId);
const [scheme, n, r, p, salt, key] = userRow.password_hash.split("$");
assert.deepEqual([scheme, Number(n), Number(r), Number(p)], ["scrypt", SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p]);
assert.deepEqual([SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p], [16384, 8, 1], "scrypt parameters per H6-2");
assert.equal(Buffer.from(salt, "base64url").length, 16);
assert.equal(Buffer.from(key, "base64url").length, 64);
assert.match(userRow.recovery_hash, /^scrypt\$16384\$8\$1\$/);
const dump = JSON.stringify(db.prepare("SELECT * FROM users").all()) + JSON.stringify(db.prepare("SELECT * FROM tokens").all());
assert.ok(!dump.includes(alicePassword), "no plain password in the database");
assert.ok(!dump.includes(aliceToken), "no raw token in the database");
assert.ok(!dump.includes(aliceRecovery.replace(/-/g, "")) && !dump.includes(aliceRecovery), "no plain recovery code");
const tokenRow = db.prepare("SELECT * FROM tokens WHERE user_id = ?").get(aliceId);
assert.match(tokenRow.hash, /^[0-9a-f]{64}$/, "tokens are kept as SHA-256 hex");
assert.equal(tokenRow.expires_at, START + 180 * DAY);

// ---- sign-in: one answer for a wrong password and an unknown user --------------
const signin = await call("POST", "/v1/auth/signin", { body: { username: aliceName.toUpperCase(), password: alicePassword } });
assert.equal(signin.status, 200);
assert.deepEqual(Object.keys(signin.body).sort(), ["token", "user"]);
assert.deepEqual(signin.body.user, { id: aliceId, username: aliceName.toLowerCase() });
assert.notEqual(signin.body.token, aliceToken, "every sign-in issues its own token");
const secondToken = signin.body.token;

// Prime the dummy hash so the counts below are one scrypt run per check.
await call("POST", "/v1/auth/signin", { body: { username: "nobody-here", password: randomSecret("pw") } });
resetHashStats();
const wrongPassword = await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: randomSecret("pw") } });
const wrongRuns = getHashStats().runs;
resetHashStats();
const unknownUser = await call("POST", "/v1/auth/signin", { body: { username: "nobody-here", password: randomSecret("pw") } });
const unknownRuns = getHashStats().runs;
resetHashStats();
const malformedUser = await call("POST", "/v1/auth/signin", { body: { username: "x", password: 5 } });
const malformedRuns = getHashStats().runs;
assert.equal(wrongPassword.status, 401);
assert.equal(unknownUser.status, 401);
assert.deepEqual(wrongPassword.body, unknownUser.body, "same code and message whether or not the user exists");
assert.deepEqual(wrongPassword.body, malformedUser.body);
assert.equal(wrongPassword.body.error.code, "invalid_credentials");
assert.equal(wrongRuns, 1);
assert.equal(unknownRuns, 1, "scrypt still runs for an unknown user");
assert.equal(malformedRuns, 1, "and for a username that cannot exist");

// ---- at most two scrypt runs at a time ----------------------------------------
resetHashStats();
const parallel = await Promise.all(
  Array.from({ length: 6 }, () => call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })),
);
assert.ok(parallel.every((result) => result.status === 200));
assert.equal(getHashStats().maxActive, 2, "concurrent hashes are capped at 2");
assert.equal(getHashStats().active, 0);
const parallelTokens = parallel.map((result) => result.body.token);

// ---- bearer tokens -----------------------------------------------------------
for (const header of [undefined, "Bearer", "Bearer short", `Basic ${aliceToken}`, `Bearer ${aliceToken}x`]) {
  const response = await api.fetch(
    new Request("http://api.test/v1/account", { headers: header ? { authorization: header } : {} }),
    { ip: "10.2.0.1" },
  );
  assert.equal(response.status, 401, `header ${header ?? "(none)"} is refused`);
  assert.equal((await response.json()).error.code, "unauthorized");
}

const account = await call("GET", "/v1/account", { token: aliceToken });
assert.equal(account.status, 200);
assert.deepEqual(account.body.user, { id: aliceId, username: aliceName.toLowerCase() });
assert.deepEqual(Object.keys(account.body.stats).sort(), ["bytes", "collections", "records"]);

// Last use is written at most once an hour.
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tokens").get().n, 9);
state.now = START + 10 * MINUTE;
await call("GET", "/v1/account", { token: aliceToken });
assert.equal(db.prepare("SELECT last_used_at FROM tokens WHERE hash = ?").get(tokenRow.hash).last_used_at, START);
state.now = START + 61 * MINUTE;
await call("GET", "/v1/account", { token: aliceToken });
const touched = db.prepare("SELECT last_used_at, expires_at FROM tokens WHERE hash = ?").get(tokenRow.hash);
assert.deepEqual({ ...touched }, { last_used_at: START + 61 * MINUTE, expires_at: START + 61 * MINUTE + 180 * DAY });

// Expiry: 180 days after the last use, sliding.
state.now = START + 61 * MINUTE + 179 * DAY;
assert.equal((await call("GET", "/v1/account", { token: aliceToken })).status, 200, "used on day 179: still valid");
state.now += 179 * DAY;
assert.equal((await call("GET", "/v1/account", { token: secondToken })).status, 401, "unused for 180 days: expired");
assert.equal((await call("GET", "/v1/account", { token: aliceToken })).status, 200, "refreshed by the last use");
state.now += 180 * DAY;
assert.equal((await call("GET", "/v1/account", { token: aliceToken })).status, 401, "180 days after the last use");
const T = state.now;

// ---- sign-out and sign-out everywhere ------------------------------------------
const s1 = (await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })).body.token;
const s2 = (await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })).body.token;
const s3 = (await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })).body.token;
const signoutNoBody = await api.fetch(
  new Request("http://api.test/v1/auth/signout", { method: "POST", headers: { authorization: `Bearer ${s1}` } }),
  { ip: "10.3.0.1" },
);
assert.equal(signoutNoBody.status, 200, "sign-out needs no body");
assert.equal((await call("GET", "/v1/account", { token: s1 })).status, 401, "sign-out revokes this token");
assert.equal((await call("GET", "/v1/account", { token: s2 })).status, 200, "and only this one");
const signoutAll = await call("POST", "/v1/auth/signout-all", { token: s2, body: {} });
assert.equal(signoutAll.status, 200);
assert.ok(signoutAll.body.revoked >= 2);
assert.equal((await call("GET", "/v1/account", { token: s2 })).status, 401);
assert.equal((await call("GET", "/v1/account", { token: s3 })).status, 401, "sign out everywhere revokes every token");
for (const token of parallelTokens) {
  assert.equal((await call("GET", "/v1/account", { token })).status, 401);
}

// ---- password change -------------------------------------------------------------
const p1 = (await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })).body.token;
const p2 = (await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })).body.token;
const newPassword = randomSecret("pw2");
const wrongCurrent = await call("POST", "/v1/auth/password", { token: p1, body: { currentPassword: randomSecret("x"), newPassword } });
assert.equal(wrongCurrent.status, 403, "a wrong current password is 403, never 401 (a 401 signs the device out, H6-11)");
assert.equal(wrongCurrent.body.error.code, "wrong_password");
const badNew = await call("POST", "/v1/auth/password", { token: p1, body: { currentPassword: alicePassword, newPassword: "short" } });
assert.equal(badNew.status, 400);
assert.equal(badNew.body.error.code, "invalid_password");
const changed = await call("POST", "/v1/auth/password", { token: p1, body: { currentPassword: alicePassword, newPassword } });
assert.equal(changed.status, 200);
assert.equal(changed.body.revoked, 1);
assert.equal((await call("GET", "/v1/account", { token: p1 })).status, 200, "the token that changed the password stays");
assert.equal((await call("GET", "/v1/account", { token: p2 })).status, 401, "every other token is revoked");
assert.equal((await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: alicePassword } })).status, 401);
assert.equal((await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: newPassword } })).status, 200);

// ---- recovery code -----------------------------------------------------------------
const recoverPassword = randomSecret("pw3");
const wrongCode = await call("POST", "/v1/auth/recover", {
  body: { username: aliceName, recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE", newPassword: recoverPassword },
});
const unknownRecover = await call("POST", "/v1/auth/recover", {
  body: { username: "nobody-here", recoveryCode: aliceRecovery, newPassword: recoverPassword },
});
assert.equal(wrongCode.status, 401);
assert.equal(wrongCode.body.error.code, "invalid_recovery");
assert.deepEqual(wrongCode.body, unknownRecover.body, "recovery does not reveal whether the user exists");
const recoverBadPassword = await call("POST", "/v1/auth/recover", {
  body: { username: aliceName, recoveryCode: aliceRecovery, newPassword: "short" },
});
assert.equal(recoverBadPassword.status, 400);
const beforeRecover = (await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: newPassword } })).body.token;
const recovered = await call("POST", "/v1/auth/recover", {
  // Lower case and no dashes: the code is normalised.
  body: { username: aliceName, recoveryCode: aliceRecovery.toLowerCase().replace(/-/g, " "), newPassword: recoverPassword },
});
assert.equal(recovered.status, 200);
assert.deepEqual(Object.keys(recovered.body).sort(), ["recoveryCode", "token", "user"]);
assert.notEqual(recovered.body.recoveryCode, aliceRecovery, "a new recovery code replaces the used one");
assert.equal((await call("GET", "/v1/account", { token: beforeRecover })).status, 401, "recovery revokes every old token");
assert.equal((await call("GET", "/v1/account", { token: p1 })).status, 401);
assert.equal((await call("GET", "/v1/account", { token: recovered.body.token })).status, 200);
assert.equal((await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: newPassword } })).status, 401);
assert.equal((await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: recoverPassword } })).status, 200);
const reused = await call("POST", "/v1/auth/recover", {
  body: { username: aliceName, recoveryCode: aliceRecovery, newPassword: randomSecret("pw4") },
});
assert.equal(reused.status, 401, "a recovery code works once");
aliceRecovery = recovered.body.recoveryCode;
aliceToken = recovered.body.token;

// ---- account deletion -------------------------------------------------------------------
const pushed = await call("POST", "/v1/sync/push", {
  token: aliceToken,
  body: { deviceId: "dev-a", ops: [{ opId: "op-delete-1", collection: "sessions", recordId: "s1", baseRev: 0, deleted: false, body: { id: "s1" } }] },
});
assert.equal(pushed.body.results[0].status, "applied");
const wrongDelete = await call("POST", "/v1/account/delete", { token: aliceToken, body: { password: randomSecret("x") } });
assert.equal(wrongDelete.status, 403);
assert.equal(wrongDelete.body.error.code, "wrong_password");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records").get().n, 1, "nothing removed on a wrong password");
const deleted = await call("POST", "/v1/account/delete", { token: aliceToken, body: { password: recoverPassword } });
assert.equal(deleted.status, 200);
for (const table of ["users WHERE id = ?", "tokens WHERE user_id = ?", "records WHERE user_id = ?", "applied_ops WHERE user_id = ?"]) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(aliceId).n, 0, `${table.split(" ")[0]} emptied`);
}
assert.equal((await call("GET", "/v1/account", { token: aliceToken })).status, 401);
assert.equal((await call("POST", "/v1/auth/signin", { body: { username: aliceName, password: recoverPassword } })).status, 401);
const again = await call("POST", "/v1/auth/signup", { body: { username: aliceName, password: alicePassword } });
assert.equal(again.status, 201, "the username is free again");
assert.notEqual(again.body.user.id, aliceId, "with a new user id");
assert.equal(state.now, T);

// ---- auth rate limits (per IP) ---------------------------------------------------------------
{
  const ip = "198.51.100.7";
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await call("POST", "/v1/auth/signout", { ip })).status, 401);
  }
  const limited = await call("POST", "/v1/auth/signin", { ip, body: { username: aliceName, password: alicePassword } });
  assert.equal(limited.status, 429, "the 11th auth request in a minute is refused");
  assert.equal(limited.body.error.code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await call("POST", "/v1/auth/signout", { ip: "198.51.100.8" })).status, 401, "another IP is not affected");
  state.now += MINUTE;
  assert.equal((await call("POST", "/v1/auth/signout", { ip })).status, 401, "a minute later it is allowed again");

  const hourIp = "198.51.100.9";
  for (let minute = 0; minute < 6; minute += 1) {
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await call("POST", "/v1/auth/signout", { ip: hourIp })).status, 401);
    }
    state.now += MINUTE;
  }
  assert.equal((await call("POST", "/v1/auth/signout", { ip: hourIp })).status, 429, "60 auth requests an hour");
  state.now += HOUR;
  assert.equal((await call("POST", "/v1/auth/signout", { ip: hourIp })).status, 401);

  const signupIp = "198.51.100.10";
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await call("POST", "/v1/auth/signup", { ip: signupIp, body: { username: "!" } })).status, 400);
  }
  state.now += 2 * MINUTE;
  assert.equal((await call("POST", "/v1/auth/signup", { ip: signupIp, body: { username: "!" } })).status, 429, "5 sign-ups an hour");
  assert.equal((await call("POST", "/v1/auth/signin", { ip: signupIp, body: { username: aliceName, password: alicePassword } })).status, 200, "sign-in from that IP still works");
}

// ---- sync rate limit (per user) ---------------------------------------------------------
{
  const token = again.body.token;
  const other = (await call("POST", "/v1/auth/signup", { body: { username: "other-user", password: alicePassword } })).body.token;
  for (let index = 0; index < 120; index += 1) {
    assert.equal((await call("GET", "/v1/sync/pull?since=0&limit=1", { token })).status, 200);
  }
  const limited = await call("GET", "/v1/sync/pull?since=0", { token });
  assert.equal(limited.status, 429, "120 sync requests a minute per user");
  assert.equal((await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops: [] } })).status, 429);
  assert.equal((await call("GET", "/v1/sync/pull?since=0", { token: other })).status, 200, "another user is not affected");
  state.now += MINUTE;
  assert.equal((await call("GET", "/v1/sync/pull?since=0", { token })).status, 200);
}

assert.deepEqual(DEFAULT_RATE_LIMITS.auth.map((rule) => [rule.windowMs, rule.max]), [[MINUTE, 10], [HOUR, 60]]);
assert.deepEqual(DEFAULT_RATE_LIMITS.signup.map((rule) => [rule.windowMs, rule.max]), [[HOUR, 5]]);
assert.deepEqual(DEFAULT_RATE_LIMITS.sync.map((rule) => [rule.windowMs, rule.max]), [[MINUTE, 120]]);
assert.equal(DEFAULT_LIMITS.tokenTtlMs, 180 * DAY);
assert.equal(DEFAULT_LIMITS.tokenTouchMs, HOUR);
api.close();

// ---- invite code ------------------------------------------------------------------------------
{
  const invite = randomSecret("invite");
  const gated = setup({ signupCode: invite });
  const body = { username: "invited", password: randomSecret("pw") };
  const missing = await gated.call("POST", "/v1/auth/signup", { body });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error.code, "invalid_invite");
  const wrong = await gated.call("POST", "/v1/auth/signup", { body: { ...body, inviteCode: `${invite}x` } });
  assert.deepEqual(wrong.body, missing.body);
  const ok = await gated.call("POST", "/v1/auth/signup", { body: { ...body, inviteCode: invite } });
  assert.equal(ok.status, 201);
  gated.api.close();
}

// ---- account cap ---------------------------------------------------------------------------
{
  const capped = setup({ maxAccounts: 2 });
  const password = randomSecret("pw");
  const first = await capped.call("POST", "/v1/auth/signup", { body: { username: "cap-one", password } });
  await capped.call("POST", "/v1/auth/signup", { body: { username: "cap-two", password } });
  const third = await capped.call("POST", "/v1/auth/signup", { body: { username: "cap-three", password } });
  assert.equal(third.status, 403);
  assert.equal(third.body.error.code, "signup_closed");
  await capped.call("POST", "/v1/account/delete", { token: first.body.token, body: { password } });
  assert.equal((await capped.call("POST", "/v1/auth/signup", { body: { username: "cap-three", password } })).status, 201);

  // Two sign-ups racing for the last place: exactly one wins.
  const racing = setup({ maxAccounts: 1 });
  const results = await Promise.all(
    ["race-a", "race-b"].map((username) => racing.call("POST", "/v1/auth/signup", { body: { username, password } })),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 403]);
  capped.api.close();
  racing.api.close();
}

// ---- every token route refuses a missing or unknown token -------------------------------
// The route table in server/app.mjs marks these with `token: true`; dropping the
// flag from any of them must fail here, not only for the routes tested above.
{
  const PROTECTED = [
    "POST /v1/auth/signout",
    "POST /v1/auth/signout-all",
    "POST /v1/auth/password",
    "GET /v1/account",
    "POST /v1/account/delete",
    "POST /v1/sync/push",
    "GET /v1/sync/pull",
  ];
  const source = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
  const marked = [...source.matchAll(/\["((?:GET|POST) \/v1\/[^"]+)", \{[^}]*\btoken: true\b/g)].map((match) => match[1]);
  assert.deepEqual(marked.sort(), [...PROTECTED].sort(), "the token routes in the route table");

  const guarded = setup();
  const password = randomSecret("pw");
  const signedUp = await guarded.call("POST", "/v1/auth/signup", { body: { username: "guard-owner", password } });
  assert.equal(signedUp.status, 201);
  const bodies = {
    "POST /v1/auth/password": { currentPassword: password, newPassword: randomSecret("pw") },
    "POST /v1/account/delete": { password },
    "POST /v1/sync/push": { deviceId: "device-guard", ops: [] },
  };
  for (const route of PROTECTED) {
    const [method, path] = route.split(" ");
    const body = method === "POST" ? bodies[route] ?? {} : undefined;
    for (const token of [undefined, "not-a-real-token", `${signedUp.body.token}x`]) {
      const result = await guarded.call(method, path, { body, token });
      assert.equal(result.status, 401, `${route} with ${token ? "a forged" : "no"} token`);
      assert.equal(result.body.error.code, "unauthorized", route);
    }
  }
  // The account is untouched by all of the refused calls.
  const still = await guarded.call("GET", "/v1/account", { token: signedUp.body.token });
  assert.equal(still.status, 200);
  guarded.api.close();
}

console.log("verify-server-auth: ok");
