import { STORAGE_KEYS } from "./storage.js";

// ---------------------------------------------------------------------------
// View helpers for the optional account and private sync (Phase H6, decisions
// H6-2, H6-8 to H6-11 and H6-24 to H6-27). Pure: no React, no DOM, no
// network, nothing stored. The Settings "Account and sync" card and the App
// shell use them; scripts/verify-ui-h6-account.mjs pins them.
// ---------------------------------------------------------------------------

/** The 15 syncable collections in plain words (singular, plural), repository order. */
export const SYNC_COLLECTION_WORDS = Object.freeze({
  sessions: ["workout session", "workout sessions"],
  nextPlans: ["next-session plan", "next-session plans"],
  setupCues: ["setup cue", "setup cues"],
  readinessByDate: ["readiness check-in", "readiness check-ins"],
  workoutDrafts: ["unsaved workout", "unsaved workouts"],
  programs: ["program", "programs"],
  programDays: ["program day", "program days"],
  programSections: ["program section", "program sections"],
  exerciseLibrary: ["Library exercise", "Library exercises"],
  programExercises: ["program exercise", "program exercises"],
  baselines: ["starting baseline", "starting baselines"],
  programStates: ["program progress record", "program progress records"],
  programProgressions: ["exercise progression", "exercise progressions"],
  programDrafts: ["saved program draft", "saved program drafts"],
  programOverrides: ["exercise hold or override", "exercise holds or overrides"],
});

export const ACCOUNT_USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const ACCOUNT_PASSWORD_MIN = 10;
export const ACCOUNT_PASSWORD_MAX = 200;

export const ACCOUNT_GUEST_SENTENCE =
  "Optional. Keeps your programs and logs in sync across your devices. Your data stays on this device too.";

/** "1 workout session", "3 workout sessions"; an unknown name reads as "record". */
export function countInWords(name, count) {
  const words = SYNC_COLLECTION_WORDS[name] ?? ["record", "records"];
  const value = Math.max(0, Math.floor(Number(count) || 0));

  return `${value} ${value === 1 ? words[0] : words[1]}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The link preview (decision H6-9) as rows in plain words. preview: the
 * engine's buildLinkPreview() result.
 * -> { rows: [{ name, label, deviceOnly, accountOnly, identical, different, parts }],
 *      totals, keptOnMerge, keptOnUseAccount, accountEmpty, deviceEmpty,
 *      mergeText, useAccountText, skippedText }
 */
export function buildLinkPreviewModel(preview) {
  const collections = preview?.collections ?? {};
  const rows = [];
  const totals = { deviceOnly: 0, accountOnly: 0, identical: 0, different: 0 };

  for (const name of Object.keys(SYNC_COLLECTION_WORDS)) {
    const counts = collections[name];

    if (!counts) {
      continue;
    }

    const row = {
      name,
      label: SYNC_COLLECTION_WORDS[name][1].replace(/^./, (letter) => letter.toUpperCase()),
      deviceOnly: Number(counts.deviceOnly) || 0,
      accountOnly: Number(counts.accountOnly) || 0,
      identical: Number(counts.identical) || 0,
      different: Number(counts.different) || 0,
    };

    Object.keys(totals).forEach((field) => {
      totals[field] += row[field];
    });

    if (row.deviceOnly + row.accountOnly + row.identical + row.different === 0) {
      continue;
    }

    row.parts = [
      row.deviceOnly ? `${row.deviceOnly} only on this device` : null,
      row.accountOnly ? `${row.accountOnly} only in the account` : null,
      row.identical ? `${row.identical} the same in both` : null,
      row.different ? `${row.different} different in both` : null,
    ].filter(Boolean);
    rows.push(row);
  }

  // Records where one side is the untouched built-in default (decision
  // H6-38), counted under "different": nothing is kept for those, and Merge
  // keeps this device's edit of a default the account never changed.
  const defaultInAccount = Math.min(totals.different, Math.max(0, Number(preview?.defaults?.inAccount) || 0));
  const defaultOnDevice = Math.min(totals.different - defaultInAccount, Math.max(0, Number(preview?.defaults?.onDevice) || 0));
  const keptOnMerge = totals.different - defaultInAccount - defaultOnDevice;
  const keptOnUseAccount = totals.different - defaultOnDevice + totals.deviceOnly;
  const skipped = Math.max(0, Number(preview?.skipped) || 0);
  const defaultsText =
    (defaultInAccount
      ? ` ${plural(defaultInAccount, "built-in default you changed on this device keeps", "built-in defaults you changed on this device keep")} this device's version.`
      : "") +
    (defaultOnDevice
      ? ` ${plural(defaultOnDevice, "untouched built-in default here takes", "untouched built-in defaults here take")} the account's version; no copy is kept.`
      : "");

  return {
    rows,
    totals,
    keptOnMerge,
    keptOnUseAccount,
    accountEmpty: totals.accountOnly + totals.identical + totals.different === 0,
    deviceEmpty: totals.deviceOnly + totals.identical + totals.different === 0,
    defaultInAccount,
    defaultOnDevice,
    mergeText:
      `Uploads ${plural(totals.deviceOnly, "record", "records")} and downloads ${totals.accountOnly}.` +
      (keptOnMerge
        ? ` Where a record differs (${keptOnMerge}), the account's version is used and this device's version is kept aside under Kept versions.`
        : defaultOnDevice
          ? ""
          : " Nothing on this device is replaced.") +
      defaultsText,
    useAccountText:
      `Downloads ${plural(totals.accountOnly, "record", "records")}, replaces ${totals.different} and removes ${totals.deviceOnly} that ${
        totals.deviceOnly === 1 ? "is" : "are"
      } only on this device.` +
      (keptOnUseAccount
        ? ` The ${plural(keptOnUseAccount, "replaced or removed record is", "replaced or removed records are")} kept aside under Kept versions.`
        : " Nothing on this device is removed.") +
      (defaultOnDevice
        ? ` ${plural(defaultOnDevice, "untouched built-in default is", "untouched built-in defaults are")} replaced without a copy.`
        : ""),
    skippedText: skipped
      ? `${plural(skipped, "record without an id stays", "records without an id stay")} on this device and ${skipped === 1 ? "is" : "are"} not synced.`
      : "",
  };
}

/** "just now", "2 min ago", "3 h ago", "4 days ago"; "" for no time. */
export function formatSyncAge(iso, now = Date.now()) {
  const time = Date.parse(iso ?? "");

  if (!Number.isFinite(time)) {
    return "";
  }

  const seconds = Math.max(0, Math.round((now - time) / 1000));

  if (seconds < 45) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours} h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const ERROR_MESSAGES = {
  invalid_credentials: "Wrong username or password.",
  invalid_recovery: "Wrong username or recovery code.",
  wrong_password: "That password is not right.",
  username_taken: "That username is taken. Choose another one.",
  invalid_username: "Usernames are 3 to 32 characters: lower-case letters, digits, dots, dashes or underscores.",
  invalid_password: `Passwords are ${ACCOUNT_PASSWORD_MIN} to ${ACCOUNT_PASSWORD_MAX} characters.`,
  invalid_invite: "That invite code is not valid.",
  signup_closed: "This sync server is not taking new accounts.",
  origin_not_allowed: "This copy of the app is not allowed to use the sync server.",
  not_configured: "Sync is not set up in this build of the app.",
  no_token: "Sign in again to resume sync.",
  unauthorized: "Sign in again to resume sync.",
  timeout: "The sync server did not answer in time. Check your connection and try again.",
  network: "Could not reach the sync server. Check your connection.",
  payload_too_large: "That is too much data to send at once.",
  quota: "Your account is full, so some changes were not accepted.",
  local_read: "Some data on this device could not be read, so nothing was synced.",
  local_shape: "Some data on this device has an unexpected shape, so nothing was synced.",
  local_changed: "Your data changed while linking. Try again.",
  local_quota: "This device's storage is full, so synced data could not be saved.",
  local_write: "Could not save synced data on this device.",
  epoch_changed: "The sync server was restored from a backup. Link this device again: your data on this device is kept.",
  busy: "The sync server is busy. Try again in a moment.",
};

/**
 * An API / engine error in plain English (decision H6-16 codes).
 * error: { kind, code, message, retryAfterMs } or null.
 */
export function describeAccountError(error) {
  if (!error) {
    return "";
  }

  if (error.kind === "rate_limited" || error.code === "rate_limited") {
    const seconds = Math.ceil((Number(error.retryAfterMs) || 0) / 1000);
    return seconds > 0
      ? `Too many attempts. Try again in ${seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`}.`
      : "Too many attempts. Try again in a moment.";
  }

  if (ERROR_MESSAGES[error.code]) {
    return ERROR_MESSAGES[error.code];
  }

  if (error.kind === "offline") {
    return ERROR_MESSAGES.network;
  }

  if (error.kind === "unauthorized") {
    return ERROR_MESSAGES.unauthorized;
  }

  if (error.kind === "server") {
    return "The sync server had a problem. Try again later.";
  }

  return typeof error.message === "string" && error.message ? error.message : "Something went wrong. Try again.";
}

/** Lower-case and trim a typed username (the server stores it lower-case, H6-2). */
export function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Client-side checks before a request (the server checks again).
 * mode: "signIn" | "signUp" | "recover" | "changePassword" | "deleteAccount"
 * -> { ok: true, values } | { ok: false, error }
 */
export function validateAccountForm(mode, input = {}) {
  const username = normalizeUsername(input.username);
  const password = String(input.password ?? "");
  const newPassword = String(input.newPassword ?? "");
  const confirm = String(input.confirmPassword ?? "");
  const fail = (error) => ({ ok: false, error });
  const checkNew = (value) => {
    if (value.length < ACCOUNT_PASSWORD_MIN || value.length > ACCOUNT_PASSWORD_MAX) {
      return ERROR_MESSAGES.invalid_password;
    }

    return value === confirm ? "" : "The two new passwords do not match.";
  };

  if (["signIn", "signUp", "recover"].includes(mode) && !ACCOUNT_USERNAME_PATTERN.test(username)) {
    return fail(ERROR_MESSAGES.invalid_username);
  }

  switch (mode) {
    case "signIn":
      return password ? { ok: true, values: { username, password } } : fail("Enter your password.");
    case "signUp": {
      if (password.length < ACCOUNT_PASSWORD_MIN || password.length > ACCOUNT_PASSWORD_MAX) {
        return fail(ERROR_MESSAGES.invalid_password);
      }

      if (password !== confirm) {
        return fail("The two passwords do not match.");
      }

      const inviteCode = String(input.inviteCode ?? "").trim();
      return { ok: true, values: { username, password, ...(inviteCode ? { inviteCode } : {}) } };
    }
    case "recover": {
      const recoveryCode = String(input.recoveryCode ?? "").trim();

      if (!recoveryCode) {
        return fail("Enter the recovery code you saved when you created the account.");
      }

      const problem = checkNew(newPassword);
      return problem ? fail(problem) : { ok: true, values: { username, recoveryCode, newPassword } };
    }
    case "changePassword": {
      if (!password) {
        return fail("Enter your current password.");
      }

      const problem = checkNew(newPassword);
      return problem ? fail(problem) : { ok: true, values: { currentPassword: password, newPassword } };
    }
    case "deleteAccount":
      return password ? { ok: true, values: { password } } : fail("Enter your password to delete the account.");
    default:
      return fail("Unknown form.");
  }
}

/**
 * The status line of the signed-in card (decision H6-11).
 * status: engine.status(); lastResult: the scheduler's last sync result.
 * -> { tone: "good" | "warn" | "bad" | "neutral", text }
 */
export function describeSyncStatus({ status, lastResult = null, online = true, now = Date.now() } = {}) {
  if (!status) {
    return { tone: "neutral", text: "" };
  }

  if (!status.signedIn) {
    return status.lastError?.kind === "unauthorized"
      ? { tone: "warn", text: "Sign in again to resume sync." }
      : { tone: "neutral", text: "Guest mode: your data is saved only on this device." };
  }

  if (!status.linked) {
    return { tone: "warn", text: "Not linked yet: choose how this device and the account are combined." };
  }

  if (status.running) {
    return { tone: "neutral", text: "Syncing..." };
  }

  const waiting = Math.max(0, Number(status.waiting) || 0);
  const waitingText = waiting ? `${plural(waiting, "change", "changes")} waiting.` : "";
  const resultStatus = lastResult?.status ?? status.lastStatus;

  if (!online || resultStatus === "offline") {
    return { tone: "warn", text: "Offline: saved on this device, will sync later." };
  }

  if (resultStatus === "needs-confirmation") {
    return { tone: "warn", text: "Sync paused: confirm the deletes below." };
  }

  if (resultStatus === "busy") {
    return { tone: "neutral", text: "Syncing in another tab." };
  }

  if (resultStatus === "error") {
    const message = describeAccountError(lastResult?.error ?? status.lastError);
    return { tone: "bad", text: [`Sync failed: ${message}`, waitingText].filter(Boolean).join(" ") };
  }

  if (waitingText) {
    return { tone: "warn", text: waitingText };
  }

  const age = formatSyncAge(status.lastSyncAt, now);
  return age ? { tone: "good", text: `Synced ${age}.` } : { tone: "neutral", text: "Not synced yet." };
}

/** The mass-delete question (decision H6-10). */
export function describeMassDelete({ deletes = 0, live = 0 } = {}) {
  return `This sync would delete ${plural(Number(deletes) || 0, "record", "records")} from your account, which holds ${
    Number(live) || 0
  } now. Confirm only if you removed them on purpose. If not, bring them back from the account; until you choose, nothing syncs.`;
}

const KEPT_SOURCES = {
  sync: "Changed on two devices; the account's version is live.",
  "link-merge": "Kept when this device was merged with the account.",
  "link-use-account": "Kept when this device took the account's data.",
};

function keptName(body, recordId) {
  if (body && typeof body === "object") {
    for (const field of ["name", "title", "exerciseName", "programExerciseName", "dayName", "date"]) {
      if (typeof body[field] === "string" && body[field].trim()) {
        return body[field].trim().slice(0, 60);
      }
    }
  }

  // A composite id (H6-7) is the JSON of its parts; the last part (the
  // program exercise) is the one a person recognises.
  const id = String(recordId ?? "");

  if (id.startsWith("[")) {
    try {
      const parts = JSON.parse(id);
      if (Array.isArray(parts) && parts.length) {
        return String(parts[parts.length - 1]).slice(0, 60);
      }
    } catch {
      // Not JSON: show the id as it is.
    }
  }

  return id.slice(0, 60);
}

/** A kept version (decisions H6-8, H6-19) as { title, detail }. */
export function describeKeptVersion(entry, now = Date.now()) {
  const words = SYNC_COLLECTION_WORDS[entry?.collection] ?? ["record", "records"];
  const kind = words[0].replace(/^./, (letter) => letter.toUpperCase());
  const name = keptName(entry?.body, entry?.recordId);
  const age = formatSyncAge(entry?.at, now);

  return {
    title: entry?.deleted ? `${kind} removed on this device` : name ? `${kind}: ${name}` : kind,
    detail: [KEPT_SOURCES[entry?.source] ?? "Kept from this device.", age ? `Kept ${age}.` : ""].filter(Boolean).join(" "),
  };
}

// ---------------------------------------------------------------------------
// App shell: what a sync write means for the state mirrored in React
// (decision H6-26).
// ---------------------------------------------------------------------------

export const SYNC_PROGRAM_STORAGE_KEYS = Object.freeze([
  STORAGE_KEYS.programs,
  STORAGE_KEYS.programDays,
  STORAGE_KEYS.programSections,
  STORAGE_KEYS.exerciseLibrary,
  STORAGE_KEYS.programExercises,
  STORAGE_KEYS.baselines,
  STORAGE_KEYS.programStates,
  STORAGE_KEYS.programProgressions,
  STORAGE_KEYS.programDrafts,
  STORAGE_KEYS.programOverrides,
]);

// Where the keys to re-read come from: this tab's sync pull (reason "sync",
// H6-26) or another tab's write (a window "storage" event, H6-35).
export const SYNC_REFRESH_SOURCES = Object.freeze({ sync: "sync", tab: "tab" });

/**
 * keys: the storage keys of a write event with reason "sync", or of another
 * tab's write (source "tab").
 * hasUnsavedDraft: the Workout Log draft has logged data.
 * -> which hook states to re-read now, and what to hold until the draft is
 *    saved: the plan of the open day (holdPlan), the program view models
 *    (deferProgramData) and the open draft's own entry (keepDraftEntry).
 * The open draft's entry is kept only against a pull: another tab's write is
 * the newest write on this device, so it is taken as it is and the open
 * draft reloads from it. Writing this tab's entry back over it would make the
 * other tab do the same, without end (decision H6-46).
 */
export function planSyncRefresh({ keys = [], hasUnsavedDraft = false, source = SYNC_REFRESH_SOURCES.sync } = {}) {
  const touched = new Set(keys);
  const programData = SYNC_PROGRAM_STORAGE_KEYS.some((key) => touched.has(key));
  const nextPlans = touched.has(STORAGE_KEYS.nextPlans);
  const workoutDrafts = touched.has(STORAGE_KEYS.workoutDrafts);

  return {
    sessions: touched.has(STORAGE_KEYS.sessions),
    readinessByDate: touched.has(STORAGE_KEYS.readinessByDate),
    setupCues: touched.has(STORAGE_KEYS.setupCues),
    nextPlans,
    workoutDrafts,
    programData: programData && !hasUnsavedDraft,
    deferProgramData: programData && hasUnsavedDraft,
    holdPlan: nextPlans && hasUnsavedDraft,
    keepDraftEntry: workoutDrafts && hasUnsavedDraft && source !== SYNC_REFRESH_SOURCES.tab,
  };
}

// Every key the app mirrors in React state and refreshes after a sync.
const MIRRORED_STORAGE_KEYS = Object.freeze([
  STORAGE_KEYS.sessions,
  STORAGE_KEYS.readinessByDate,
  STORAGE_KEYS.setupCues,
  STORAGE_KEYS.nextPlans,
  STORAGE_KEYS.workoutDrafts,
  ...SYNC_PROGRAM_STORAGE_KEYS,
]);

/**
 * Decision H6-35: the keys a window "storage" event (a write by another tab
 * or window of the app) asks this tab to re-read, so a tab never saves an
 * older copy over what another tab wrote or pulled. event.key null means the
 * other tab cleared storage: every mirrored key. A key the app does not
 * mirror, or an event from another storage area, gives [].
 */
export function storageEventKeys(event, storageArea) {
  if (!event || (storageArea && event.storageArea && event.storageArea !== storageArea)) {
    return [];
  }

  if (event.key === null || event.key === undefined) {
    return [...MIRRORED_STORAGE_KEYS];
  }

  return MIRRORED_STORAGE_KEYS.includes(event.key) ? [event.key] : [];
}

/**
 * The workout drafts map a refresh sets (H6-26, H6-46): the stored map, with
 * the open draft's own entry kept when the plan says so.
 */
export function workoutDraftsAfterRefresh(storedDrafts, currentDrafts, draftKey, plan) {
  return plan?.keepDraftEntry ? keepWorkoutDraftEntry(storedDrafts, currentDrafts, draftKey) : storedDrafts;
}

/** The pulled drafts map with the open draft's own entry kept (H6-26). */
export function keepWorkoutDraftEntry(pulledDrafts, currentDrafts, draftKey) {
  const pulled = pulledDrafts && typeof pulledDrafts === "object" && !Array.isArray(pulledDrafts) ? pulledDrafts : {};
  const own = draftKey ? currentDrafts?.[draftKey] : undefined;

  if (own === undefined || JSON.stringify(pulled[draftKey]) === JSON.stringify(own)) {
    return pulled;
  }

  return { ...pulled, [draftKey]: own };
}
