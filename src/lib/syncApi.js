// ---------------------------------------------------------------------------
// Private sync API client (Phase H6, decisions H6-2 to H6-6, H6-11). Pure:
// fetch, the token getter and the timer are injected, nothing is stored here.
// Every method resolves (never rejects) to { ok: true, data } or
// { ok: false, error: { kind, code, message, status, retryAfterMs } }.
// kind: "offline" (fetch threw, or the 20 s timeout) | "unauthorized" (401)
//     | "rate_limited" (429) | "server" (5xx, or an unreadable answer)
//     | "rejected" (any other 4xx).
// The token is sent as `Authorization: Bearer` and never appears in a result.
// ---------------------------------------------------------------------------

export const SYNC_API_TIMEOUT_MS = 20000;

export const SYNC_API_ERROR_KINDS = Object.freeze({
  offline: "offline",
  unauthorized: "unauthorized",
  rejected: "rejected",
  server: "server",
  rateLimited: "rate_limited",
});

/** The routes of server/app.mjs (decisions H6-3, H6-5, H6-6). */
export const SYNC_API_ROUTES = Object.freeze({
  health: "GET /v1/health",
  signUp: "POST /v1/auth/signup",
  signIn: "POST /v1/auth/signin",
  signOut: "POST /v1/auth/signout",
  signOutAll: "POST /v1/auth/signout-all",
  recover: "POST /v1/auth/recover",
  changePassword: "POST /v1/auth/password",
  getAccount: "GET /v1/account",
  deleteAccount: "POST /v1/account/delete",
  push: "POST /v1/sync/push",
  pull: "GET /v1/sync/pull",
});

const DEFAULT_MESSAGES = {
  offline: "Could not reach the sync server. Check your connection.",
  unauthorized: "Sign in again to resume sync.",
  rate_limited: "Too many requests. Try again in a moment.",
  server: "The sync server had a problem. Try again later.",
  rejected: "The sync server refused the request.",
};

function makeError(kind, { code, message, status = null, retryAfterMs = null } = {}) {
  return {
    ok: false,
    error: {
      kind,
      code: code || kind,
      message: message || DEFAULT_MESSAGES[kind],
      status,
      retryAfterMs,
    },
  };
}

function kindForStatus(status) {
  if (status === 401) {
    return SYNC_API_ERROR_KINDS.unauthorized;
  }

  if (status === 429) {
    return SYNC_API_ERROR_KINDS.rateLimited;
  }

  return status >= 500 ? SYNC_API_ERROR_KINDS.server : SYNC_API_ERROR_KINDS.rejected;
}

function parseRetryAfter(response) {
  const value = Number(response?.headers?.get?.("retry-after"));

  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

/** Keeps only the op fields the server takes (H6-5); `hash` stays on the client. */
export function toWireOp(op) {
  return {
    opId: op.opId,
    collection: op.collection,
    recordId: op.recordId,
    baseRev: op.baseRev,
    deleted: Boolean(op.deleted),
    body: op.deleted ? null : op.body,
  };
}

/**
 * createSyncApi({ baseUrl, fetch, getToken, timeoutMs = 20000, setTimer, clearTimer })
 * baseUrl: e.g. import.meta.env.VITE_SYNC_API_URL (no trailing slash needed);
 * fetch: a fetch-compatible function; getToken: () => string ("" when signed out).
 */
export function createSyncApi({
  baseUrl,
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  getToken = () => "",
  timeoutMs = SYNC_API_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");

  async function request(route, { body, query, auth = true } = {}) {
    if (!base || typeof fetchImpl !== "function") {
      return makeError(SYNC_API_ERROR_KINDS.offline, {
        code: "not_configured",
        message: "Sync is not configured in this build.",
      });
    }

    const [method, path] = route.split(" ");
    const search = query ? `?${new URLSearchParams(query).toString()}` : "";
    const headers = {};

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    if (auth) {
      const token = String(getToken() ?? "");

      if (!token) {
        return makeError(SYNC_API_ERROR_KINDS.unauthorized, { code: "no_token" });
      }

      headers.authorization = `Bearer ${token}`;
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      controller?.abort();
    }, timeoutMs);
    let response;

    try {
      response = await fetchImpl(`${base}${path}${search}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (error) {
      clearTimer(timer);
      return makeError(SYNC_API_ERROR_KINDS.offline, {
        code: timedOut || error?.name === "AbortError" ? "timeout" : "network",
        message: timedOut ? "The sync server did not answer in time." : undefined,
      });
    }

    let text = "";

    try {
      text = await response.text();
    } catch {
      clearTimer(timer);
      return makeError(timedOut ? SYNC_API_ERROR_KINDS.offline : SYNC_API_ERROR_KINDS.server, {
        code: timedOut ? "timeout" : "bad_response",
        status: response.status,
      });
    }

    clearTimer(timer);

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = undefined;
    }

    if (response.ok) {
      return data && typeof data === "object"
        ? { ok: true, data }
        : makeError(SYNC_API_ERROR_KINDS.server, { code: "bad_response", status: response.status });
    }

    const detail = data?.error && typeof data.error === "object" ? data.error : data ?? {};

    return makeError(kindForStatus(response.status), {
      code: typeof detail.code === "string" ? detail.code : `http_${response.status}`,
      message: typeof detail.message === "string" ? detail.message : undefined,
      status: response.status,
      retryAfterMs: response.status === 429 ? parseRetryAfter(response) : null,
    });
  }

  return {
    /** GET /v1/health -> { ok, version } */
    health: () => request(SYNC_API_ROUTES.health, { auth: false }),
    /** -> { token, user: { id, username }, recoveryCode } */
    signUp: ({ username, password, inviteCode } = {}) =>
      request(SYNC_API_ROUTES.signUp, {
        auth: false,
        body: { username, password, ...(inviteCode ? { inviteCode } : {}) },
      }),
    /** -> { token, user: { id, username } } */
    signIn: ({ username, password } = {}) =>
      request(SYNC_API_ROUTES.signIn, { auth: false, body: { username, password } }),
    /** Revokes this token. -> { ok } */
    signOut: () => request(SYNC_API_ROUTES.signOut, { body: {} }),
    /** Revokes every token of the user. -> { ok, revoked } */
    signOutAll: () => request(SYNC_API_ROUTES.signOutAll, { body: {} }),
    /** -> { token, user, recoveryCode } (a new code; every old token is revoked) */
    recover: ({ username, recoveryCode, newPassword } = {}) =>
      request(SYNC_API_ROUTES.recover, { auth: false, body: { username, recoveryCode, newPassword } }),
    /** -> { ok, revoked } (other tokens are revoked) */
    changePassword: ({ currentPassword, newPassword } = {}) =>
      request(SYNC_API_ROUTES.changePassword, { body: { currentPassword, newPassword } }),
    /** -> { user: { id, username }, stats: { records, bytes, collections } } */
    getAccount: () => request(SYNC_API_ROUTES.getAccount),
    /** -> { ok } */
    deleteAccount: ({ password } = {}) => request(SYNC_API_ROUTES.deleteAccount, { body: { password } }),
    /**
     * ops: at most 200, client fields are stripped. epoch: the database epoch
     * the device last saw (decision H6-31); a different one is refused with
     * 409 epoch_changed and nothing applied.
     * -> { results: [{ opId, status, rev, seq | deleted, body | code }], epoch }
     */
    push: ({ deviceId, ops, epoch } = {}) =>
      request(SYNC_API_ROUTES.push, {
        body: { deviceId, ops: (ops ?? []).map(toWireOp), ...(typeof epoch === "string" && epoch ? { epoch } : {}) },
      }),
    /** -> { records: [{ collection, recordId, rev, seq, deleted, body }], nextSince, more, epoch } */
    pull: ({ since = 0, limit = 500 } = {}) =>
      request(SYNC_API_ROUTES.pull, { query: { since: String(since), limit: String(limit) } }),
  };
}
