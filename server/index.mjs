import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createApi, DEFAULT_LIMITS } from "./app.mjs";
import { openDatabase } from "./db.mjs";

// node:http wrapper around createApi (decision H6-1, H6-12). Before a single
// body byte is read it asks api.gate (origin, route, token, rate limit) and
// gets the route's own body cap (16 KB for the account routes, 4 MB for an
// authenticated push - decision H6-29); all buffered bodies together stay
// under the in-flight budgets of decision H6-44. It then turns the IncomingMessage into a WHATWG
// Request, writes the Response back, logs one access line per request (time,
// method, path, status, ms - never a body, header, token or query) and shuts
// down cleanly on SIGTERM / SIGINT.

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const DEV_ORIGINS = Object.freeze(["http://127.0.0.1:5173", "http://localhost:5173"]);
export const DEV_PORT = 3100;
export const DEV_DB_PATH = path.join(serverDir, "..", ".data", "loadms-dev.db");
// All request bodies being buffered at once stay under these (decisions H6-29,
// H6-44). Bodies sent with a token (pushes, account changes) and bodies sent
// without one (sign-up, sign-in, recovery) have separate budgets, so traffic
// before sign-in can never starve a signed-in push; one user and one client
// address each hold at most their own share of their budget.
export const DEFAULT_MAX_IN_FLIGHT_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_ANON_IN_FLIGHT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_USER_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_IP_IN_FLIGHT_BYTES = 64 * 1024;
// The example file's placeholder: a server started with it would let anyone
// who read deploy/api.env.example sign up (decision H6-41).
const PLACEHOLDER_SIGNUP_CODE = /^replace-with/i;

function parseOrigins(text) {
  return String(text ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * readConfig(env, argv) -> { dev, port, host, dbPath, allowedOrigins,
 *   signupCode, maxAccounts, trustProxy }
 */
export function readConfig(env = process.env, argv = process.argv.slice(2)) {
  const dev = argv.includes("--dev");

  if (dev) {
    return {
      dev: true,
      port: DEV_PORT,
      host: "127.0.0.1",
      dbPath: DEV_DB_PATH,
      allowedOrigins: [...DEV_ORIGINS],
      signupCode: null,
      maxAccounts: 50,
      trustProxy: false,
    };
  }

  const port = env.LOADMS_PORT === undefined || env.LOADMS_PORT === "" ? 3100 : Number(env.LOADMS_PORT);
  const maxAccounts =
    env.LOADMS_MAX_ACCOUNTS === undefined || env.LOADMS_MAX_ACCOUNTS === "" ? 50 : Number(env.LOADMS_MAX_ACCOUNTS);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("LOADMS_PORT must be a port number.");
  }

  if (!Number.isInteger(maxAccounts) || maxAccounts < 0) {
    throw new Error("LOADMS_MAX_ACCOUNTS must be a whole number.");
  }

  if (!env.LOADMS_DB) {
    throw new Error("LOADMS_DB must name the database file (or run with --dev).");
  }

  if (env.LOADMS_SIGNUP_CODE && PLACEHOLDER_SIGNUP_CODE.test(env.LOADMS_SIGNUP_CODE.trim())) {
    throw new Error("LOADMS_SIGNUP_CODE is still the example placeholder: set your own invite code (or leave it empty).");
  }

  return {
    dev: false,
    port,
    host: env.LOADMS_HOST || "127.0.0.1",
    dbPath: env.LOADMS_DB,
    allowedOrigins: parseOrigins(env.LOADMS_ALLOWED_ORIGINS),
    signupCode: env.LOADMS_SIGNUP_CODE ? env.LOADMS_SIGNUP_CODE : null,
    maxAccounts,
    trustProxy: env.LOADMS_TRUST_PROXY === "1",
  };
}

// The client address for rate limits: the socket peer, or with trustProxy the
// last X-Forwarded-For entry (the one Caddy itself appended).
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const last = String(Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();

    if (last) {
      return last;
    }
  }

  return req.socket.remoteAddress ?? "unknown";
}

function safePath(rawUrl) {
  let pathname = "/";

  try {
    pathname = new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    pathname = "/";
  }

  return pathname.replace(/[^\x21-\x7e]/g, "?").slice(0, 200);
}

function accessLine(method, rawUrl, status, ms) {
  const verb = /^[A-Z]{1,10}$/.test(method ?? "") ? method : "?";
  return `${new Date().toISOString()} ${verb} ${safePath(rawUrl)} ${status} ${ms}ms`;
}

function headersFrom(req) {
  const headers = new Headers();

  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];

    if (name.startsWith(":")) {
      continue;
    }

    try {
      headers.append(name, req.rawHeaders[index + 1]);
    } catch {
      // A header value the Fetch API refuses is dropped.
    }
  }

  return headers;
}

// One request's share of the in-flight budgets: its pool and its owner's own
// cap (a user id or a client address). Owners are forgotten once they hold
// nothing.
function createBudget(pools, owners, gate) {
  const pool = pools[gate.pool === "user" ? "user" : "anon"];
  const ownerKey = `${gate.pool === "user" ? "user" : "anon"}${gate.key ?? "unknown"}`;
  const ownerMax = gate.pool === "user" ? pools.userMax : pools.ipMax;

  return {
    fits(bytes) {
      return pool.used + bytes <= pool.max && (owners.get(ownerKey) ?? 0) + bytes <= ownerMax;
    },
    add(bytes) {
      pool.used += bytes;
      const held = (owners.get(ownerKey) ?? 0) + bytes;

      if (held > 0) {
        owners.set(ownerKey, held);
      } else {
        owners.delete(ownerKey);
      }
    },
  };
}

// Reads the whole request body, refusing it once it passes maxBytes or once
// it would pass its in-flight budgets (decisions H6-29, H6-44).
function collectBody(req, maxBytes, budget) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);

    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ tooLarge: true });
      return;
    }

    const chunks = [];
    let total = 0;
    let done = false;
    const release = () => {
      budget.add(-total);
      total = 0;
    };
    const stop = (result) => {
      done = true;
      chunks.length = 0;
      release();
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (done) {
        return;
      }

      if (total + chunk.length > maxBytes) {
        stop({ tooLarge: true });
        return;
      }

      if (!budget.fits(chunk.length)) {
        stop({ busy: true });
        return;
      }

      total += chunk.length;
      budget.add(chunk.length);
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        // The bytes stay counted until the request is answered.
        resolve({ body: Buffer.concat(chunks), release });
      }
    });
    req.on("error", () => {
      if (!done) {
        stop({ aborted: true });
      }
    });
  });
}

async function writeResponse(res, response, method) {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = {};

  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  headers["content-length"] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(method === "HEAD" ? undefined : body);
}

/**
 * createHttpHandler(api, { maxBytes, maxInFlightBytes, maxAnonInFlightBytes,
 *   maxUserInFlightBytes, maxIpInFlightBytes, trustProxy, log }) -> (req, res) => void
 * maxBytes is an upper bound on top of the route's own cap from api.gate.
 * maxInFlightBytes: every body sent with a token; maxAnonInFlightBytes: every
 * body sent without one; maxUserInFlightBytes / maxIpInFlightBytes: one user's
 * and one client address's share of those (decision H6-44).
 */
export function createHttpHandler(
  api,
  {
    maxBytes = DEFAULT_LIMITS.requestBytes,
    maxInFlightBytes = DEFAULT_MAX_IN_FLIGHT_BYTES,
    maxAnonInFlightBytes = DEFAULT_MAX_ANON_IN_FLIGHT_BYTES,
    maxUserInFlightBytes = DEFAULT_MAX_USER_IN_FLIGHT_BYTES,
    maxIpInFlightBytes = DEFAULT_MAX_IP_IN_FLIGHT_BYTES,
    trustProxy = false,
    log = console.log,
  } = {},
) {
  const pools = {
    user: { used: 0, max: maxInFlightBytes },
    anon: { used: 0, max: maxAnonInFlightBytes },
    userMax: Math.min(maxUserInFlightBytes, maxInFlightBytes),
    ipMax: Math.min(maxIpInFlightBytes, maxAnonInFlightBytes),
  };
  const owners = new Map();

  return async function handleHttp(req, res) {
    const started = process.hrtime.bigint();
    const finish = (status) => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      log(accessLine(req.method, req.url, status, ms));
    };

    let release = null;

    try {
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = `http://localhost${url.pathname}${url.search}`;
      const headers = headersFrom(req);
      const ip = clientIp(req, trustProxy);
      // Refusals that need no body are answered before any of it is read.
      const gate = api.gate({ method, url: target, headers }, { ip });

      if (gate.response) {
        req.resume();
        await writeResponse(res, gate.response, method);
        finish(gate.response.status);
        return;
      }

      const collected = hasBody
        ? await collectBody(req, Math.min(maxBytes, gate.maxBytes), createBudget(pools, owners, gate))
        : { body: null };
      release = collected.release ?? null;

      if (collected.aborted) {
        finish(499);
        return;
      }

      if (collected.tooLarge || collected.busy) {
        // Answer at once; whatever is still arriving is read and discarded
        // (closing with unread data would reset the socket before the client
        // reads the answer). requestTimeout bounds how long that can go on.
        req.resume();
        const refusal = collected.busy
          ? api.errorResponse(headers, 503, "busy", { "retry-after": "5" })
          : api.errorResponse(headers, 413, "payload_too_large");
        await writeResponse(res, refusal, method);
        finish(refusal.status);
        return;
      }

      const request = new Request(target, {
        method,
        headers,
        body: hasBody && collected.body?.length ? collected.body : undefined,
      });
      const response = await api.fetch(request, { ip });
      await writeResponse(res, response, method);
      finish(response.status);
    } catch (error) {
      console.error("loadms-api http error:", error?.message ?? error);

      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: { code: "invalid_request", message: "The request is not valid." } }));
      } else {
        res.destroy();
      }

      finish(400);
    } finally {
      release?.();
    }
  };
}

/**
 * startServer({ config, db?, log?, clock? }) -> Promise<{ server, api, port, close() }>
 * config is readConfig()'s shape; db defaults to openDatabase(config.dbPath).
 */
export async function startServer({ config, db, log = console.log, clock } = {}) {
  const database = db ?? openDatabase(config.dbPath);
  const api = createApi({
    db: database,
    config: {
      allowedOrigins: config.allowedOrigins,
      signupCode: config.signupCode,
      maxAccounts: config.maxAccounts,
    },
    ...(clock ? { clock } : {}),
  });
  const server = http.createServer(createHttpHandler(api, { trustProxy: config.trustProxy, log }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  let closing = null;

  return {
    server,
    api,
    port: server.address().port,
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => {
          api.close();
          resolve();
        });
        server.closeIdleConnections?.();
        // Requests still running get a few seconds, then their sockets go.
        setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
      });
      return closing;
    },
  };
}

async function main() {
  let config;

  try {
    config = readConfig();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const running = await startServer({ config });
  console.log(
    `loadms-api listening on http://${config.host}:${running.port}${config.dev ? " (dev)" : ""}, ${config.allowedOrigins.length} allowed origin(s)`,
  );

  const shutdown = (signal) => {
    console.log(`loadms-api ${signal}: shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    running.close().then(() => process.exit(0));
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("loadms-api failed to start:", error?.message ?? error);
    process.exit(1);
  });
}
