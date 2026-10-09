import assert from "node:assert/strict";
import http from "node:http";

import { SERVER_VERSION } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
import { clientIp, DEV_ORIGINS, DEV_PORT, readConfig, startServer } from "../server/index.mjs";

// H6 Track A: the node:http wrapper (decisions H6-1, H6-3, H6-12, H6-13).
// A real server on 127.0.0.1 port 0 with an in-memory database: CORS
// preflight for allowed and refused origins, the 4 MB cap while streaming,
// malformed JSON, health, security headers and an access log that never
// carries a token, password, body or query.

const ALLOWED = "https://loadms-test.example";
const logLines = [];
const running = await startServer({
  config: {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: [ALLOWED, ...DEV_ORIGINS],
    signupCode: null,
    maxAccounts: 50,
    trustProxy: false,
  },
  db: openDatabase(":memory:"),
  log: (line) => logLines.push(line),
});

function send({ method = "GET", path, headers = {}, body, chunks }) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({ host: "127.0.0.1", port: running.port, method, path, headers }, (res) => {
      answered = true;
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
      });
      res.on("error", reject);
    });
    // A write error after the answer arrived is ignored; one before it fails.
    req.on("error", (error) => (answered ? null : reject(error)));
    req.setTimeout(20_000, () => req.destroy(new Error(`no answer for ${method} ${path}`)));

    if (chunks) {
      for (const chunk of chunks) {
        req.write(chunk);
      }
      req.end();
    } else {
      req.end(body);
    }
  });
}

try {
  // ---- health and security headers --------------------------------------------------------
  const health = await send({ path: "/v1/health" });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, version: SERVER_VERSION });
  assert.equal(health.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["x-frame-options"], "DENY");
  assert.equal(health.headers["referrer-policy"], "no-referrer");
  assert.equal(health.headers["cache-control"], "no-store");
  assert.match(health.headers["content-security-policy"], /default-src 'none'/);
  assert.match(health.headers["strict-transport-security"], /max-age=/);
  assert.equal(health.headers["access-control-allow-origin"], undefined, "no CORS header without an Origin");
  assert.equal(health.headers["set-cookie"], undefined, "no cookies");

  // ---- CORS -----------------------------------------------------------------------------------
  for (const origin of [ALLOWED, "http://127.0.0.1:5173", "http://localhost:5173"]) {
    const preflight = await send({
      method: "OPTIONS",
      path: "/v1/sync/push",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });
    assert.equal(preflight.status, 204, `${origin} preflight`);
    assert.equal(preflight.headers["access-control-allow-origin"], origin);
    assert.equal(preflight.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    assert.equal(preflight.headers["access-control-allow-headers"], "authorization, content-type");
    assert.equal(preflight.headers["access-control-allow-credentials"], undefined, "no credentials mode");
    assert.match(preflight.headers.vary, /Origin/);
    const real = await send({ path: "/v1/health", headers: { origin } });
    assert.equal(real.status, 200);
    assert.equal(real.headers["access-control-allow-origin"], origin);
  }
  for (const origin of ["https://evil.example", "http://127.0.0.1:5174", `${ALLOWED}.evil.example`, "null"]) {
    const preflight = await send({ method: "OPTIONS", path: "/v1/sync/push", headers: { origin, "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 403, `${origin} preflight is refused`);
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    assert.equal(preflight.body.error.code, "origin_not_allowed");
    const real = await send({
      method: "POST",
      path: "/v1/auth/signup",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username: "from-evil", password: "p".repeat(12) }),
    });
    assert.equal(real.status, 403, `${origin} cannot call the API at all`);
    assert.equal(real.headers["access-control-allow-origin"], undefined);
  }

  // ---- account flow over HTTP (feeds the log check below) ---------------------------------------
  const password = `pw-${crypto.randomUUID()}`;
  const signup = await send({
    method: "POST",
    path: "/v1/auth/signup",
    headers: { origin: ALLOWED, "content-type": "application/json" },
    body: JSON.stringify({ username: "http-user", password }),
  });
  assert.equal(signup.status, 201);
  const token = signup.body.token;
  const recoveryCode = signup.body.recoveryCode;
  const secretBody = `secret-body-${crypto.randomUUID()}`;
  const push = await send({
    method: "POST",
    path: "/v1/sync/push",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "http-device", ops: [{ opId: "op-http-1", collection: "sessions", recordId: "s1", baseRev: 0, deleted: false, body: { note: secretBody } }] }),
  });
  assert.equal(push.body.results[0].status, "applied");
  const pull = await send({ path: `/v1/sync/pull?since=0&limit=10&probe=${secretBody}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(pull.body.records[0].body.note, secretBody);

  // ---- malformed JSON, wrong type, unknown routes ---------------------------------------------------
  const malformed = await send({ method: "POST", path: "/v1/auth/signin", headers: { "content-type": "application/json" }, body: '{"username":' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "invalid_json");
  const notJson = await send({ method: "POST", path: "/v1/auth/signin", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=a" });
  assert.equal(notJson.status, 415);
  const unknown = await send({ path: "/v1/nope" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "not_found");
  const wrongMethod = await send({ path: "/v1/auth/signin" });
  assert.equal(wrongMethod.status, 405);

  // ---- 4 MB cap ---------------------------------------------------------------------------------------
  const cap = 4 * 1024 * 1024;
  const declared = await send({
    method: "POST",
    path: "/v1/sync/push",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(cap + 1) },
    body: Buffer.alloc(cap + 1, 32),
  });
  assert.equal(declared.status, 413, "a declared length over 4 MB is refused");
  assert.equal(declared.body.error.code, "payload_too_large");
  const streamed = await send({
    method: "POST",
    path: "/v1/sync/push",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked" },
    chunks: Array.from({ length: 5 }, () => Buffer.alloc(1024 * 1024, 32)),
  });
  assert.equal(streamed.status, 413, "a chunked body is cut off once it passes 4 MB");
  const atCap = await send({
    method: "POST",
    path: "/v1/sync/push",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "d", ops: [], pad: "p".repeat(cap - 40) }),
  });
  assert.equal(atCap.status, 200, "a body just under 4 MB is read");
  assert.equal((await send({ path: "/v1/health" })).status, 200, "the server is fine afterwards");

  // ---- access log ----------------------------------------------------------------------------------------
  const log = logLines.join("\n");
  assert.ok(logLines.length >= 20);
  for (const line of logLines) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z [A-Z]+ \/\S* \d{3} \d+ms$/, `log line shape: ${line.slice(0, 60)}`);
  }
  assert.ok(log.includes("POST /v1/auth/signup 201"));
  assert.ok(log.includes("GET /v1/sync/pull 200"), "the path is logged without its query");
  assert.ok(log.includes("POST /v1/sync/push 413"));
  for (const secret of [token, password, recoveryCode, secretBody, "probe=", "since=", "Bearer", "http-user"]) {
    assert.ok(!log.includes(secret), "the access log carries no token, password, recovery code, body or query");
  }

  // ---- config and proxy address ------------------------------------------------------------------------
  const dev = readConfig({}, ["--dev"]);
  assert.equal(dev.port, DEV_PORT);
  assert.equal(dev.port, 3100);
  assert.equal(dev.host, "127.0.0.1");
  assert.deepEqual(dev.allowedOrigins, ["http://127.0.0.1:5173", "http://localhost:5173"]);
  assert.equal(dev.signupCode, null);
  assert.match(dev.dbPath.replace(/\\/g, "/"), /\/\.data\/loadms-dev\.db$/);
  const prod = readConfig(
    {
      LOADMS_DB: "/opt/loadms/data/loadms.db",
      LOADMS_ALLOWED_ORIGINS: " https://a.example/ ,https://b.example",
      LOADMS_SIGNUP_CODE: "invite",
      LOADMS_MAX_ACCOUNTS: "7",
      LOADMS_TRUST_PROXY: "1",
    },
    [],
  );
  assert.deepEqual(prod, {
    dev: false,
    port: 3100,
    host: "127.0.0.1",
    dbPath: "/opt/loadms/data/loadms.db",
    allowedOrigins: ["https://a.example", "https://b.example"],
    signupCode: "invite",
    maxAccounts: 7,
    trustProxy: true,
  });
  assert.throws(() => readConfig({}, []), /LOADMS_DB/);
  assert.throws(() => readConfig({ LOADMS_DB: "x.db", LOADMS_PORT: "http" }, []), /LOADMS_PORT/);
  assert.equal(readConfig({ LOADMS_DB: "x.db" }, []).maxAccounts, 50);
  const fakeReq = (forwarded) => ({ headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }, socket: { remoteAddress: "127.0.0.1" } });
  assert.equal(clientIp(fakeReq("203.0.113.5"), true), "203.0.113.5");
  assert.equal(clientIp(fakeReq("6.6.6.6, 203.0.113.5"), true), "203.0.113.5", "the entry Caddy appended, not a client-supplied one");
  assert.equal(clientIp(fakeReq("203.0.113.5"), false), "127.0.0.1", "without trust the socket address is used");
  assert.equal(clientIp(fakeReq(undefined), true), "127.0.0.1");
} finally {
  await running.close();
}

console.log("verify-server-http: ok");
