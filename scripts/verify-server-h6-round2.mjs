import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { createApi, DEFAULT_LIMITS } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
import {
  createHttpHandler,
  DEFAULT_MAX_ANON_IN_FLIGHT_BYTES,
  DEFAULT_MAX_IN_FLIGHT_BYTES,
  DEFAULT_MAX_IP_IN_FLIGHT_BYTES,
  DEFAULT_MAX_USER_IN_FLIGHT_BYTES,
} from "../server/index.mjs";

// H6 review round 2, server side:
// - H6-43: one push answer carries at most pushConflictBytes of conflict
//   bodies (at least one), and each record's body at most once, so a tiny
//   push naming one big record 200 times cannot build a 100 MB answer;
// - H6-44: bodies sent without a token (sign-up, sign-in, recovery) and
//   bodies sent with one have separate in-flight budgets, and one client
//   address or one user holds at most its own share, so slow sign-in uploads
//   never make a signed-in push answer 503 busy.

const ORIGIN = "https://loadms-round2.example";
const OPEN_LIMITS = {
  auth: [{ windowMs: 60_000, max: 100_000 }],
  signup: [{ windowMs: 3_600_000, max: 100_000 }],
  sync: [{ windowMs: 60_000, max: 100_000 }],
};
let checks = 0;

function secret(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function setup(limits = {}) {
  const api = createApi({ db: openDatabase(":memory:"), config: { allowedOrigins: [ORIGIN], rateLimits: OPEN_LIMITS, limits } });

  async function call(method, route, { body, token, ip = "10.20.0.1" } = {}) {
    const init = { method, headers: {} };

    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    if (token) {
      init.headers.authorization = `Bearer ${token}`;
    }

    const response = await api.fetch(new Request(`http://api.test${route}`, init), { ip });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), body: text ? JSON.parse(text) : null };
  }

  return { api, call };
}

const op = (opId, recordId, baseRev, body, deleted = false) => ({
  opId,
  collection: "sessions",
  recordId,
  baseRev,
  deleted,
  body: deleted ? null : body,
});

// ---- 1. one big record named 200 times with a stale baseRev -------------------------------------------
{
  const { api, call } = setup();
  const user = await call("POST", "/v1/auth/signup", { body: { username: "amp-user", password: secret("pw") } });
  const token = user.body.token;
  const big = { id: "s1", note: "x".repeat(510 * 1024) };
  const first = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops: [op("seed-op-0001", "s1", 0, big)] } });
  assert.equal(first.body.results[0].status, "applied");

  const ops = Array.from({ length: DEFAULT_LIMITS.opsPerPush }, (_, index) => op(`conflict-${index}`, "s1", 0, { id: "s1" }));
  assert.ok(JSON.stringify({ deviceId: "d", ops }).length < 32 * 1024, "the request is tiny");
  const answer = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops } });
  assert.equal(answer.status, 200);
  assert.ok(answer.bytes < 600 * 1024, `the answer carries the body once (${answer.bytes} bytes)`);
  const [withBody, ...rest] = answer.body.results;
  assert.equal(withBody.status, "conflict");
  assert.equal(withBody.opId, "conflict-0");
  assert.deepEqual(withBody.body, big, "the first conflict carries the server body");
  assert.equal(withBody.bodyOmitted, undefined);
  assert.equal(rest.length, 199);
  for (const result of rest) {
    assert.equal(result.status, "conflict");
    assert.equal(result.rev, 1);
    assert.equal(result.deleted, false);
    assert.equal(result.body, null);
    assert.equal(result.bodyOmitted, true, "the same record's body is not sent twice");
  }
  api.close();
  checks += 1;
}

// ---- 2. the byte budget across records, at least one body, tombstones ---------------------------------
{
  assert.equal(DEFAULT_LIMITS.pushConflictBytes, 4 * 1024 * 1024);
  const { api, call } = setup({ pushConflictBytes: 1500 });
  const user = await call("POST", "/v1/auth/signup", { body: { username: "budget-user", password: secret("pw") } });
  const token = user.body.token;
  const body = (id) => ({ id, note: id.repeat(1000 / id.length) });
  const seeded = await call("POST", "/v1/sync/push", {
    token,
    body: {
      deviceId: "d",
      ops: [op("seed-op-a001", "a", 0, body("a")), op("seed-op-b001", "b", 0, body("b")), op("seed-op-c001", "c", 0, body("c")), op("seed-op-t001", "t", 0, null, true)],
    },
  });
  assert.deepEqual(seeded.body.results.map((result) => result.status), ["applied", "applied", "applied", "applied"]);

  const stale = await call("POST", "/v1/sync/push", {
    token,
    body: {
      deviceId: "d",
      ops: [op("stale-op-t", "t", 0, { id: "t" }), op("stale-op-b", "b", 0, { id: "b" }), op("stale-op-a", "a", 0, { id: "a" }), op("stale-op-c", "c", 0, { id: "c" })],
    },
  });
  const [tomb, b, a, c] = stale.body.results;
  assert.deepEqual(tomb, { opId: "stale-op-t", status: "conflict", rev: 1, deleted: true, body: null }, "a tombstone needs no body");
  assert.deepEqual(b.body, body("b"), "the first live body is always sent, even past a small budget");
  assert.deepEqual([a.bodyOmitted, a.body], [true, null], "past the budget: no body");
  assert.deepEqual([c.bodyOmitted, c.body], [true, null]);

  // Sent again alone, each gets its body (the client's next round).
  const again = await call("POST", "/v1/sync/push", { token, body: { deviceId: "d", ops: [op("stale-op-a", "a", 0, { id: "a" })] } });
  assert.deepEqual(again.body.results[0].body, body("a"));
  assert.equal(again.body.results[0].bodyOmitted, undefined);
  api.close();
  checks += 1;
}

// ---- 3. in-flight budgets over HTTP: slow sign-ins never starve a signed-in push ---------------------------
{
  assert.equal(DEFAULT_MAX_IN_FLIGHT_BYTES, 12 * 1024 * 1024);
  assert.ok(DEFAULT_MAX_ANON_IN_FLIGHT_BYTES <= 1024 * 1024, "pre-auth bodies have a small budget of their own");
  assert.ok(DEFAULT_MAX_IP_IN_FLIGHT_BYTES <= 64 * 1024, "one address holds at most a few sign-in bodies");
  assert.ok(DEFAULT_MAX_USER_IN_FLIGHT_BYTES < DEFAULT_MAX_IN_FLIGHT_BYTES, "one user never holds the whole budget");

  const api = createApi({ db: openDatabase(":memory:"), config: { allowedOrigins: [ORIGIN], rateLimits: OPEN_LIMITS } });
  const server = http.createServer(
    createHttpHandler(api, {
      log: () => {},
      trustProxy: true,
      maxInFlightBytes: 512 * 1024,
      maxUserInFlightBytes: 400 * 1024,
      maxAnonInFlightBytes: 256 * 1024,
      maxIpInFlightBytes: 48 * 1024,
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const sockets = [];

  // A raw request that declares 16 KiB and sends one byte less, then waits.
  function slowSignin(ip) {
    const socket = net.connect(port, "127.0.0.1");
    const state = { socket, answer: "" };
    socket.on("data", (part) => {
      state.answer += part.toString("utf8");
    });
    socket.on("error", () => {});
    socket.write(
      `POST /v1/auth/signin HTTP/1.1\r\nHost: api.test\r\nContent-Type: application/json\r\nContent-Length: 16384\r\nX-Forwarded-For: ${ip}\r\n\r\n`,
    );
    socket.write(Buffer.alloc(16383, 32));
    sockets.push(state);
    return state;
  }

  function request(route, { body, token, ip = "10.30.0.200", hold = false } = {}) {
    const headers = { "content-type": "application/json", "x-forwarded-for": ip, origin: ORIGIN };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    let resolveAnswer;
    const answer = new Promise((resolve) => {
      resolveAnswer = resolve;
    });
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: route, headers }, (res) => {
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        resolveAnswer({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", () => {});

    if (hold) {
      req.setHeader("transfer-encoding", "chunked");
      req.write(body);
    } else {
      req.end(body);
    }

    return { req, answer };
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const push = (token, pad, { hold = false } = {}) =>
    request("/v1/sync/push", { token, body: `{"deviceId":"d","ops":[],"pad":"${"p".repeat(pad)}${hold ? "" : '"}'}`, hold });

  try {
    const signups = [];
    for (const name of ["pool-user-a", "pool-user-b"]) {
      const created = await request("/v1/auth/signup", { body: JSON.stringify({ username: name, password: secret("pw") }) }).answer;
      assert.equal(created.status, 201);
      signups.push(created.body.token);
    }
    const [tokenA, tokenB] = signups;

    // 40 slow sign-ins from one address, 30 from as many others.
    for (let index = 0; index < 40; index += 1) {
      slowSignin("10.30.0.1");
    }
    for (let index = 0; index < 30; index += 1) {
      slowSignin(`10.31.0.${index + 1}`);
    }
    await wait(400);

    const refused = (list) => list.filter((state) => state.answer.includes(" 503 ") && state.answer.includes('"busy"')).length;
    const refusedOneIp = refused(sockets.slice(0, 40));
    assert.ok(refusedOneIp >= 37, `one address holds at most its share (${refusedOneIp} of 40 refused)`);
    const refusedOthers = refused(sockets.slice(40));
    assert.ok(refusedOthers >= 10, `the pre-auth budget is bounded (${refusedOthers} of 30 refused)`);

    const pushed = await push(tokenA, 300 * 1024).answer;
    assert.equal(pushed.status, 200, "a signed-in push still goes through");

    // One user's share: a held 300 KB push, then a second one of the same user
    // is refused while another user's push passes.
    const held = push(tokenA, 300 * 1024, { hold: true });
    await wait(150);
    const sameUser = await push(tokenA, 150 * 1024).answer;
    assert.equal(sameUser.status, 503, "one user holds at most its own share");
    const otherUser = await push(tokenB, 200 * 1024).answer;
    assert.equal(otherUser.status, 200, "another user's push is not starved by it");
    held.req.end('"}');
    assert.equal((await held.answer).status, 200);
  } finally {
    sockets.forEach((state) => state.socket.destroy());
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    api.close();
  }
  checks += 1;
}

console.log(`verify-server-h6-round2: ok (${checks} checks)`);
