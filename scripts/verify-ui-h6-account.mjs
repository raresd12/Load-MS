import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase H6, UI track (decisions H6-2, H6-8 to H6-11, H6-24 to H6-27): the
// Settings "Account and sync" card, the sync scheduler and the App shell's
// refresh after a sync.
// 1. src/lib/accountView.js: plain-English copy, form checks, the link
//    preview model, the status line, the refresh plan of a sync write.
// 2. src/components/account/syncScheduler.js with a fake engine and fake
//    timers: no request for a guest, offline or unlinked device; 4 s after the
//    last user write; sync writes ignored; back-off; focus / visible /
//    interval / online triggers.
// 3. Source structure: autocomplete attributes, Export before Merge, the
//    token never handled outside the engine, nothing logged, the sync code
//    out of a guest's startup path, the API address in one module.
// 4. The account components rendered on the server (Vite SSR) with fake
//    engines: the guest forms, the link preview and the signed-in panel.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const view = await import("../src/lib/accountView.js");
const {
  ACCOUNT_GUEST_SENTENCE,
  SYNC_COLLECTION_WORDS,
  buildLinkPreviewModel,
  countInWords,
  describeAccountError,
  describeKeptVersion,
  describeMassDelete,
  describeSyncStatus,
  formatSyncAge,
  keepWorkoutDraftEntry,
  normalizeUsername,
  planSyncRefresh,
  validateAccountForm,
} = view;
const { STORAGE_KEYS } = await import("../src/lib/storage.js");
const { getSyncableCollections } = await import("../src/lib/repository.js");
const {
  createSyncScheduler,
  SYNC_BUSY_RECHECK_MS,
  SYNC_INTERVAL_MS,
  SYNC_PASSIVE_GAP_MS,
  SYNC_WRITE_DELAY_MS,
} = await import("../src/components/account/syncScheduler.js");

let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};

// ---------------------------------------------------------------------------
// 1. accountView
// ---------------------------------------------------------------------------
check(() => {
  assert.equal(
    ACCOUNT_GUEST_SENTENCE,
    "Optional. Keeps your programs and logs in sync across your devices. Your data stays on this device too.",
  );
  const syncable = getSyncableCollections().map((collection) => collection.name);
  assert.deepEqual(Object.keys(SYNC_COLLECTION_WORDS), syncable, "every syncable collection has plain words, in repository order");
  assert.equal(countInWords("sessions", 1), "1 workout session");
  assert.equal(countInWords("sessions", 3), "3 workout sessions");
  assert.equal(countInWords("programOverrides", 2), "2 exercise holds or overrides");
  assert.equal(countInWords("unknown", 1), "1 record");
});

check(() => {
  const preview = {
    ok: true,
    collections: Object.fromEntries(
      Object.keys(SYNC_COLLECTION_WORDS).map((name) => [name, { deviceOnly: 0, accountOnly: 0, identical: 0, different: 0 }]),
    ),
    skipped: 1,
  };
  preview.collections.sessions = { deviceOnly: 3, accountOnly: 2, identical: 1, different: 1 };
  preview.collections.programs = { deviceOnly: 0, accountOnly: 0, identical: 2, different: 0 };
  const model = buildLinkPreviewModel(preview);
  assert.deepEqual(
    model.rows.map((row) => row.name),
    ["sessions", "programs"],
    "only collections with records are listed",
  );
  assert.equal(model.rows[0].label, "Workout sessions");
  assert.deepEqual(model.rows[0].parts, [
    "3 only on this device",
    "2 only in the account",
    "1 the same in both",
    "1 different in both",
  ]);
  assert.equal(model.keptOnMerge, 1, "merge keeps the device side of a difference");
  assert.equal(model.keptOnUseAccount, 4, "use-account keeps every replaced or removed device record");
  assert.equal(model.accountEmpty, false);
  assert.match(model.mergeText, /^Uploads 3 records and downloads 2\./);
  assert.match(model.mergeText, /kept aside under Kept versions/);
  assert.match(model.useAccountText, /removes 3 that are only on this device/);
  assert.match(model.useAccountText, /The 4 replaced or removed records are kept aside under Kept versions\./);
  assert.equal(model.skippedText, "1 record without an id stays on this device and is not synced.");

  const fresh = buildLinkPreviewModel({ collections: { sessions: { deviceOnly: 2, accountOnly: 0, identical: 0, different: 0 } } });
  assert.equal(fresh.accountEmpty, true, "a new account is empty");
  assert.match(fresh.mergeText, /Nothing on this device is replaced\./);
  assert.deepEqual(buildLinkPreviewModel(null).rows, []);
});

check(() => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  assert.equal(formatSyncAge("2026-10-07T11:59:40.000Z", now), "just now");
  assert.equal(formatSyncAge("2026-10-07T11:58:00.000Z", now), "2 min ago");
  assert.equal(formatSyncAge("2026-10-07T09:00:00.000Z", now), "3 h ago");
  assert.equal(formatSyncAge("2026-10-06T12:00:00.000Z", now), "1 day ago");
  assert.equal(formatSyncAge(null, now), "");
});

check(() => {
  assert.equal(describeAccountError({ kind: "unauthorized", code: "invalid_credentials" }), "Wrong username or password.");
  assert.equal(describeAccountError({ kind: "rejected", code: "username_taken" }), "That username is taken. Choose another one.");
  assert.equal(describeAccountError({ kind: "rejected", code: "wrong_password" }), "That password is not right.");
  assert.equal(describeAccountError({ kind: "rejected", code: "invalid_invite" }), "That invite code is not valid.");
  assert.equal(describeAccountError({ kind: "rate_limited", retryAfterMs: 30000 }), "Too many attempts. Try again in 30 s.");
  assert.equal(describeAccountError({ kind: "rate_limited", retryAfterMs: 600000 }), "Too many attempts. Try again in 10 min.");
  assert.equal(describeAccountError({ kind: "offline", code: "network" }), "Could not reach the sync server. Check your connection.");
  assert.equal(describeAccountError({ kind: "offline", code: "not_configured" }), "Sync is not set up in this build of the app.");
  assert.equal(describeAccountError({ kind: "server", code: "http_500" }), "The sync server had a problem. Try again later.");
  assert.equal(describeAccountError(null), "");
});

check(() => {
  assert.equal(normalizeUsername("  Ana.B "), "ana.b");
  assert.deepEqual(validateAccountForm("signIn", { username: "Ana", password: "x" }), {
    ok: true,
    values: { username: "ana", password: "x" },
  });
  assert.equal(validateAccountForm("signIn", { username: "a", password: "x" }).ok, false, "short username");
  assert.equal(validateAccountForm("signIn", { username: "ana", password: "" }).error, "Enter your password.");
  assert.equal(validateAccountForm("signUp", { username: "ana", password: "short", confirmPassword: "short" }).ok, false);
  assert.equal(
    validateAccountForm("signUp", { username: "ana", password: "long enough 1", confirmPassword: "long enough 2" }).error,
    "The two passwords do not match.",
  );
  assert.deepEqual(
    validateAccountForm("signUp", { username: "ana", password: "long enough 1", confirmPassword: "long enough 1", inviteCode: " k " }).values,
    { username: "ana", password: "long enough 1", inviteCode: "k" },
  );
  assert.equal(validateAccountForm("recover", { username: "ana", recoveryCode: "", newPassword: "long enough 1", confirmPassword: "long enough 1" }).ok, false);
  assert.deepEqual(
    validateAccountForm("recover", { username: "ana", recoveryCode: "AAAA", newPassword: "long enough 1", confirmPassword: "long enough 1" }).values,
    { username: "ana", recoveryCode: "AAAA", newPassword: "long enough 1" },
  );
  assert.deepEqual(
    validateAccountForm("changePassword", { password: "old", newPassword: "long enough 1", confirmPassword: "long enough 1" }).values,
    { currentPassword: "old", newPassword: "long enough 1" },
  );
  assert.equal(validateAccountForm("deleteAccount", { password: "" }).ok, false);
});

check(() => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const base = { signedIn: true, linked: true, running: false, waiting: 0, lastSyncAt: "2026-10-07T11:58:00.000Z", lastStatus: "synced" };
  assert.deepEqual(describeSyncStatus({ status: base, now }), { tone: "good", text: "Synced 2 min ago." });
  assert.deepEqual(describeSyncStatus({ status: { ...base, waiting: 3 }, now }), { tone: "warn", text: "3 changes waiting." });
  assert.deepEqual(describeSyncStatus({ status: { ...base, waiting: 1 }, now }), { tone: "warn", text: "1 change waiting." });
  assert.deepEqual(describeSyncStatus({ status: base, online: false, now }), {
    tone: "warn",
    text: "Offline: saved on this device, will sync later.",
  });
  assert.deepEqual(describeSyncStatus({ status: base, lastResult: { status: "offline" }, now }).text, "Offline: saved on this device, will sync later.");
  assert.deepEqual(
    describeSyncStatus({ status: { ...base, waiting: 2 }, lastResult: { status: "error", error: { kind: "server", code: "http_500" } }, now }),
    { tone: "bad", text: "Sync failed: The sync server had a problem. Try again later. 2 changes waiting." },
  );
  assert.equal(describeSyncStatus({ status: base, lastResult: { status: "busy" }, now }).text, "Syncing in another tab.");
  assert.equal(describeSyncStatus({ status: { ...base, running: true }, now }).text, "Syncing...");
  assert.equal(describeSyncStatus({ status: { ...base, linked: false }, now }).tone, "warn");
  assert.equal(
    describeSyncStatus({ status: { signedIn: false, linked: false, lastError: { kind: "unauthorized" } }, now }).text,
    "Sign in again to resume sync.",
  );
  assert.equal(describeSyncStatus({ status: { ...base, lastSyncAt: null }, now }).text, "Not synced yet.");
  assert.match(describeMassDelete({ deletes: 30, live: 40 }), /^This sync would delete 30 records from your account, which holds 40 now\./);
});

check(() => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  assert.deepEqual(
    describeKeptVersion({ collection: "programs", recordId: "p1", body: { name: "Push pull" }, source: "sync", at: "2026-10-07T11:58:00.000Z" }, now),
    { title: "Program: Push pull", detail: "Changed on two devices; the account's version is live. Kept 2 min ago." },
  );
  assert.equal(describeKeptVersion({ collection: "sessions", recordId: "s1", deleted: true, source: "link-use-account" }, now).title, "Workout session removed on this device");
  assert.equal(
    describeKeptVersion({ collection: "baselines", recordId: JSON.stringify(["program-a", "bench-press"]), body: { programId: "program-a" }, source: "link-merge" }, now).title,
    "Starting baseline: bench-press",
    "a composite id shows its last part, not raw JSON",
  );
});

// The App shell's refresh plan (decision H6-26).
check(() => {
  const plain = planSyncRefresh({ keys: [STORAGE_KEYS.sessions, STORAGE_KEYS.nextPlans, STORAGE_KEYS.programs], hasUnsavedDraft: false });
  assert.equal(plain.sessions, true);
  assert.equal(plain.nextPlans, true);
  assert.equal(plain.programData, true, "program keys refresh the program view models");
  assert.equal(plain.holdPlan, false);
  assert.equal(plain.deferProgramData, false);

  const busy = planSyncRefresh({
    keys: [STORAGE_KEYS.nextPlans, STORAGE_KEYS.baselines, STORAGE_KEYS.workoutDrafts],
    hasUnsavedDraft: true,
  });
  assert.equal(busy.holdPlan, true, "a workout in progress keeps its plan");
  assert.equal(busy.programData, false, "no program refresh under an open workout");
  assert.equal(busy.deferProgramData, true, "the program refresh waits for the save");
  assert.equal(busy.keepDraftEntry, true, "the open draft's entry is kept");
  assert.equal(busy.sessions, false, "untouched keys are not re-read");

  const pulled = { a: { v: 1 }, b: { v: 2 } };
  assert.deepEqual(keepWorkoutDraftEntry(pulled, { b: { v: 9 } }, "b"), { a: { v: 1 }, b: { v: 9 } }, "the open draft wins");
  assert.equal(keepWorkoutDraftEntry(pulled, { b: { v: 2 } }, "b"), pulled, "identical: the pulled map as is");
  assert.equal(keepWorkoutDraftEntry(pulled, {}, "b"), pulled, "no open entry: the pulled map as is");
  assert.deepEqual(keepWorkoutDraftEntry(null, { c: 1 }, "c"), { c: 1 });
});

// ---------------------------------------------------------------------------
// 2. Scheduler with fakes
// ---------------------------------------------------------------------------
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();

  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        tasks.set(id, { fn, at: now + ms, every: null });
        return id;
      },
      clearTimeout(id) {
        tasks.delete(id);
      },
      setInterval(fn, ms) {
        const id = nextId++;
        tasks.set(id, { fn, at: now + ms, every: ms });
        return id;
      },
      clearInterval(id) {
        tasks.delete(id);
      },
    },
    pending: () => [...tasks.values()].filter((task) => task.every === null).length,
    async advance(ms) {
      const end = now + ms;

      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];

        if (!due) {
          break;
        }

        const [id, task] = due;
        now = task.at;

        if (task.every) {
          task.at += task.every;
        } else {
          tasks.delete(id);
        }

        task.fn();
        await flush();
      }

      now = end;
      await flush();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function createFakeTarget() {
  const handlers = new Map();
  return {
    visibilityState: "visible",
    onLine: true,
    addEventListener(type, fn) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== fn));
    },
    fire(type) {
      (handlers.get(type) ?? []).forEach((fn) => fn({ type }));
    },
    count: () => [...handlers.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

function createFakeEngine(initial = {}) {
  const state = { signedIn: true, linked: true, failures: 0, retryDelayMs: 0, waiting: 0, ...initial };
  const calls = { syncNow: [], refreshWaiting: 0 };
  const results = [];

  return {
    state,
    calls,
    results,
    status: () => ({ ...state, running: false, lastSyncAt: null, conflicts: 0 }),
    async refreshWaiting() {
      calls.refreshWaiting += 1;
      return state.signedIn && state.linked ? state.waiting : null;
    },
    async syncNow(options) {
      calls.syncNow.push(options);
      const result = results.shift() ?? { status: "synced", waiting: 0 };

      if (result.status === "offline" || result.status === "error") {
        state.failures += 1;
        state.retryDelayMs = 30000 * 2 ** (state.failures - 1);
      } else if (result.status === "synced") {
        state.failures = 0;
        state.retryDelayMs = 0;
        state.waiting = 0;
      }

      return result;
    },
  };
}

function setup(engineState) {
  const clock = createFakeTimers();
  const win = createFakeTarget();
  const doc = createFakeTarget();
  const nav = { onLine: true };
  const writeListeners = new Set();
  const engine = createFakeEngine(engineState);
  const scheduler = createSyncScheduler({
    engine,
    subscribeWrites: (listener) => {
      writeListeners.add(listener);
      return () => writeListeners.delete(listener);
    },
    windowLike: win,
    documentLike: doc,
    navigatorLike: nav,
    timers: clock.timers,
    clock: clock.now,
  });
  const emit = (reason) => [...writeListeners].forEach((listener) => listener({ keys: [STORAGE_KEYS.sessions], reason }));
  scheduler.start();
  return { clock, win, doc, nav, engine, scheduler, emit, writeListeners };
}

assert.equal(SYNC_WRITE_DELAY_MS, 4000);
assert.equal(SYNC_INTERVAL_MS, 300000);

// A guest: no sync call from any trigger.
{
  const { clock, win, doc, engine, scheduler, emit } = setup({ signedIn: false, linked: false });
  assert.equal((await scheduler.run("launch")).status, "signed-out");
  emit("write");
  await clock.advance(SYNC_WRITE_DELAY_MS + 1);
  win.fire("focus");
  win.fire("online");
  doc.fire("visibilitychange");
  await clock.advance(SYNC_INTERVAL_MS * 2);
  await scheduler.run("manual");
  assert.equal(engine.calls.syncNow.length, 0, "a guest never syncs");
  checks += 1;
}

// Signed in but not linked: no sync either.
{
  const { engine, scheduler } = setup({ signedIn: true, linked: false });
  assert.equal((await scheduler.run("launch")).status, "needs-link");
  assert.equal(engine.calls.syncNow.length, 0);
  checks += 1;
}

// Linked: launch, the 4 s write debounce, sync events ignored, nothing to send.
{
  const { clock, engine, scheduler, emit } = setup();
  await scheduler.run("launch");
  assert.equal(engine.calls.syncNow.length, 1, "launch syncs");

  engine.state.waiting = 2;
  emit("write");
  await clock.advance(2000);
  emit("write");
  await clock.advance(SYNC_WRITE_DELAY_MS - 1);
  assert.equal(engine.calls.syncNow.length, 1, "4 s after the LAST write, not before");
  await clock.advance(1);
  assert.equal(engine.calls.syncNow.length, 2, "the debounced write syncs once");

  emit("sync");
  await clock.advance(SYNC_WRITE_DELAY_MS * 2);
  assert.equal(engine.calls.syncNow.length, 2, "a write by the sync itself never triggers a sync");

  engine.state.waiting = 0;
  emit("write");
  await clock.advance(SYNC_WRITE_DELAY_MS);
  assert.equal(engine.calls.syncNow.length, 2, "a write with nothing waiting (the App mirroring a pull) is not a sync");
  assert.ok(engine.calls.refreshWaiting >= 2);
  checks += 1;
}

// Offline: no request, the status says offline; the online event syncs.
{
  const { nav, win, engine, scheduler } = setup();
  nav.onLine = false;
  const result = await scheduler.run("manual");
  assert.equal(result.status, "offline");
  assert.equal(engine.calls.syncNow.length, 0, "offline: no request");
  assert.equal(scheduler.getSnapshot().online, false);
  nav.onLine = true;
  win.fire("online");
  await flush();
  assert.equal(engine.calls.syncNow.length, 1, "back online: sync");
  checks += 1;
}

// Back-off after a failure; manual bypasses; the retry timer fires.
{
  const { clock, win, engine, scheduler } = setup();
  engine.results.push({ status: "offline", error: { kind: "offline" } });
  await scheduler.run("launch");
  assert.equal(engine.state.failures, 1);
  await clock.advance(SYNC_PASSIVE_GAP_MS + 1);
  win.fire("focus");
  await flush();
  assert.equal(engine.calls.syncNow.length, 1, "focus during the 30 s back-off waits");
  await clock.advance(30000);
  assert.equal(engine.calls.syncNow.length, 2, "the retry timer syncs after the back-off");
  assert.equal(engine.state.failures, 0);
  engine.results.push({ status: "error", error: { kind: "server" } });
  await scheduler.run("manual");
  await scheduler.run("manual");
  assert.equal(engine.calls.syncNow.length, 4, "Sync now always tries");
  checks += 1;
}

// Passive triggers: a gap after the last attempt; the interval only while visible.
{
  const { clock, win, doc, engine, scheduler } = setup();
  await scheduler.run("launch");
  win.fire("focus");
  await flush();
  assert.equal(engine.calls.syncNow.length, 1, "focus right after a sync waits");
  await clock.advance(SYNC_PASSIVE_GAP_MS);
  doc.fire("visibilitychange");
  await flush();
  assert.equal(engine.calls.syncNow.length, 2, "visible again after the gap syncs");
  doc.visibilityState = "hidden";
  await clock.advance(SYNC_INTERVAL_MS);
  assert.equal(engine.calls.syncNow.length, 2, "no interval sync while hidden");
  doc.visibilityState = "visible";
  await clock.advance(SYNC_INTERVAL_MS);
  assert.equal(engine.calls.syncNow.length, 3, "every 5 min while visible");
  checks += 1;
}

// Another tab holds the lock: a busy result keeps the last line and looks
// again shortly.
{
  const { clock, engine, scheduler } = setup();
  await scheduler.run("launch");
  engine.results.push({ status: "busy" });
  await scheduler.run("manual");
  assert.equal(scheduler.getSnapshot().lastResult.status, "synced", "busy does not replace the last result");
  assert.equal(engine.calls.syncNow.length, 2);
  await clock.advance(SYNC_BUSY_RECHECK_MS);
  assert.equal(engine.calls.syncNow.length, 3, "a busy result is looked at again 15 s later");
  scheduler.stop();
  checks += 1;
}

// H6-48: a subscriber gets the current snapshot at once, so a card that read
// "running" just before a run ended (and its notify) never keeps showing
// "Syncing..." until the next notify.
{
  const { engine, scheduler } = setup();
  let running = true;
  const baseStatus = engine.status;
  engine.status = () => ({ ...baseStatus(), running });
  assert.equal(scheduler.getSnapshot().status.running, true, "the card reads a running sync");
  running = false;
  scheduler.notify(); // the run ends before the card has subscribed
  const seen = [];
  const unsubscribe = scheduler.subscribe((snapshot) => seen.push(snapshot.status.running));
  assert.deepEqual(seen, [false], "subscribing delivers the current snapshot at once");
  scheduler.notify();
  assert.deepEqual(seen, [false, false]);
  unsubscribe();
  scheduler.notify();
  assert.equal(seen.length, 2, "an unsubscribed listener hears nothing");
  const quietUnsubscribe = scheduler.subscribe(() => {
    throw new Error("listener failure");
  });
  quietUnsubscribe();
  scheduler.stop();
  checks += 1;
}

// Mass delete: the confirmation is passed through; stop removes every listener.
{
  const { win, doc, engine, scheduler, writeListeners, clock } = setup();
  engine.results.push({ status: "needs-confirmation", deletes: 30, live: 40, waiting: 30 });
  const paused = await scheduler.run("manual");
  assert.equal(paused.status, "needs-confirmation");
  assert.equal(scheduler.getSnapshot().lastResult.status, "needs-confirmation");
  await scheduler.run("manual", { confirmMassDelete: true });
  assert.deepEqual(engine.calls.syncNow.map((options) => options.confirmMassDelete), [false, true]);
  scheduler.stop();
  assert.equal(win.count() + doc.count(), 0, "stop removes the window and document listeners");
  assert.equal(writeListeners.size, 0, "stop unsubscribes from storage writes");
  assert.equal(clock.pending(), 0, "stop clears the timers");
  checks += 1;
}

// ---------------------------------------------------------------------------
// 3. Source structure
// ---------------------------------------------------------------------------
const accountDir = "src/components/account";
const accountFiles = readdirSync(path.join(root, accountDir)).map((name) => `${accountDir}/${name}`);
const forms = read(`${accountDir}/AccountAuthForms.jsx`);
const linkPreview = read(`${accountDir}/AccountLinkPreview.jsx`);
const panel = read(`${accountDir}/AccountSignedInPanel.jsx`);
const card = read(`${accountDir}/AccountSyncCard.jsx`);
const controller = read(`${accountDir}/syncController.js`);
const settings = read("src/pages/SettingsPage.jsx");
const app = read("src/App.jsx");

check(() => {
  assert.ok(forms.includes('autoComplete="username"'), "the username field is autocomplete=username");
  assert.ok(forms.includes('autoComplete={mode === "signUp" ? "new-password" : "current-password"}'), "sign in = current-password, create = new-password");
  assert.equal((forms.match(/autoComplete="new-password"/g) ?? []).length, 2, "the new and repeated passwords of recover / create are new-password");
  assert.ok(forms.includes('id="account-invite-code"'), "create account has an invite code field");
  assert.ok(forms.includes('id="account-recovery-code"'), "recovery asks for the recovery code");
  assert.equal((panel.match(/autoComplete="current-password"/g) ?? []).length, 2, "change password and delete account ask for the current password");
  assert.equal((panel.match(/autoComplete="new-password"/g) ?? []).length, 2);
  assert.ok(/type="password"/.test(forms) && /type="password"/.test(panel), "passwords are masked");
});

check(() => {
  // The link preview (decision H6-9): Export first, then Merge, Use the account's data, Cancel.
  const jsx = linkPreview.slice(linkPreview.indexOf("  return ("));
  const order = [/\n\s*Export Data\n/, /"Merge"/, /"Use the account's data on this device"/, /\n\s*Cancel\n\s*<\/button>/].map((pattern) => {
    const match = pattern.exec(jsx);
    return match ? match.index : -1;
  });
  assert.ok(order.every((index) => index > 0), `every link choice is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "Export Data comes before Merge, Use the account's data and Cancel");
  assert.ok(/onClick=\{\(\) => choose\("merge"\)\}\s*className="focus-ring btn btn-primary/.test(linkPreview), "Merge is the primary button");
  assert.ok(/onClick=\{\(\) => choose\("useAccount"\)\}\s*className="focus-ring btn btn-secondary/.test(linkPreview), "Use the account's data is secondary");
  assert.ok(linkPreview.includes("{preview.useAccountText}"), "Use the account's data states what is kept aside");
});

check(() => {
  for (const text of [
    "Account and sync",
    "I saved it",
    "Save your recovery code",
    "Keep this version",
    "Discard",
    "Sign out everywhere",
    "Change password",
    "Delete account",
    "Sync now",
    "Forgot your password?",
  ]) {
    assert.ok([card, panel, forms].some((source) => source.includes(text)), `copy: ${text}`);
  }
  assert.ok(card.includes("{ACCOUNT_GUEST_SENTENCE}"), "the guest sentence is shown");
  assert.ok(/onSubmit=\{handleDeleteAccount\}[\s\S]*className="focus-ring btn btn-danger min-h-11 w-full"/.test(panel), "Delete account is .btn-danger");
  assert.ok(/The data on this device stays/.test(panel), "delete explains that local data stays");
  assert.ok(settings.includes("<AccountSyncCard onExportData={handleExportData} onSignedInChange={setAccountSignedIn} />"), "Settings renders the card");
  assert.ok(
    settings.indexOf("<AccountSyncCard") < settings.indexOf('<p className="text-sm font-semibold text-text-1">Backup</p>'),
    "the account card sits above Backup, at the top of Settings",
  );
});

check(() => {
  // H6-9 / H6-27 (fix round 3): Export Data still works after linking. The
  // signed-in state hides only the Guest Mode box; the Backup card and its
  // Export Data button render whether or not the device is signed in.
  const jsx = settings.slice(settings.indexOf("  return ("));
  const gates = [];
  for (const match of jsx.matchAll(/\{[^{}]*\baccountSignedIn\b[^{}]*(?:&&|\?)\s*\(/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < jsx.length; end += 1) {
      if (jsx[end] === "{") depth += 1;
      if (jsx[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    gates.push([match.index, end]);
  }
  assert.equal(gates.length, 1, "one block in Settings depends on the sign-in state");
  const [gateStart, gateEnd] = gates[0];
  assert.match(jsx.slice(gateStart, gateEnd), /^\{!accountSignedIn && \(/, "it renders only while signed out");
  assert.ok(jsx.slice(gateStart, gateEnd).includes("Guest Mode"), "and it is the Guest Mode box");
  assert.equal((settings.match(/\baccountSignedIn\b/g) ?? []).length, 2, "accountSignedIn is declared once and read once (the Guest Mode gate)");

  const backupTitle = jsx.indexOf('<p className="text-sm font-semibold text-text-1">Backup</p>');
  const sectionStart = jsx.lastIndexOf("<section", backupTitle);
  const sectionEnd = jsx.indexOf("</section>", backupTitle);
  const backup = jsx.slice(sectionStart, sectionEnd);
  assert.ok(backupTitle > gateEnd, "the Backup card is outside the signed-out block");
  assert.match(backup, /onClick=\{handleExportData\}[\s\S]*Export Data/, "the Backup card has the Export Data button");
  assert.match(jsx.slice(jsx.lastIndexOf("\n", sectionStart), sectionStart), /^\n\s*$/, "the Backup card is not behind a condition");
  const exportButton = jsx.indexOf("onClick={handleExportData}");
  assert.ok(exportButton > gateEnd, "Export Data is outside the signed-out block");
  assert.ok(/<AccountSyncCard onExportData=\{handleExportData\}/.test(jsx), "the link preview offers the same export");
});

check(() => {
  // Nothing logged; tokens and passwords are handled only by the engine.
  for (const file of [...accountFiles, "src/lib/accountView.js"]) {
    const code = read(file);
    assert.ok(!/\bconsole\./.test(code), `${file} logs nothing`);
    assert.ok(!/\b(writeStorage|writeStorageBatch|writeSecret|writeDeviceValue|readSecret|setItem|sessionStorage|indexedDB)\b/.test(code), `${file} stores nothing itself`);
    assert.ok(!/\btoken\b/i.test(code.replace(/\/\/.*$/gm, "").replace(/readToken/g, "")), `${file} never handles the token (only syncController reads it for the API)`);
  }
  assert.ok(controller.includes("getToken: () => storage.readToken()"), "the API gets the token from the secret store on each request");
});

check(() => {
  // A guest's startup path never loads the sync code (no request, H6-11).
  assert.ok(!/from "\.\/components\/account\//.test(app), "App.jsx imports no account module statically");
  assert.ok(!/from "\.\/lib\/sync(Engine|Api)\.js"/.test(app), "App.jsx imports neither the engine nor the API client");
  assert.ok(
    /if \(!readSecret\(SECRET_STORAGE_KEYS\.syncToken\)\) \{\s*return undefined;\s*\}[\s\S]{0,80}import\("\.\/components\/account\/syncController\.js"\)/.test(app),
    "the controller is imported only when a sync token exists",
  );
  assert.ok(app.includes('getSyncController().scheduler.run("launch");'), "a signed-in launch syncs");
  assert.ok(
    /subscribeStorageWrites\(\(event\) => \{\s*if \(event\.reason === STORAGE_WRITE_REASONS\.sync\) \{\s*applySyncedKeysRef\.current\?\.\(event\.keys\);/.test(app),
    "the shell re-reads state after a sync write, without a reload",
  );
  assert.ok(!/location\.reload/.test(app.slice(app.indexOf("applySyncedKeysRef"), app.indexOf("applySyncedKeysRef") + 4000)), "no reload in the sync refresh");
  assert.ok(app.includes("planSyncRefresh({ keys, hasUnsavedDraft, source })"), "the shell asks the refresh plan");
  assert.ok(app.includes("workoutDraftsAfterRefresh(stored, workoutDrafts, draftKey, plan)"), "the open draft is kept when the plan says so");
  assert.ok(/syncHeldPlan && syncHeldPlan\.dayId === selectedDayId \? syncHeldPlan\.entry : nextPlans\[selectedDayId\]/.test(app), "the open day keeps its plan");
});

check(() => {
  // VITE_SYNC_API_URL is read in one module only.
  const walk = (dir) =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    );
  const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const readers = walk("src").filter((file) => code(file).includes("VITE_SYNC_API_URL"));
  assert.deepEqual(readers, [`${accountDir}/syncController.js`]);
  assert.ok(existsSync(path.join(root, ".env.development")) && existsSync(path.join(root, ".env.production")));
  assert.equal(read(".env.development"), "VITE_SYNC_API_URL=http://127.0.0.1:3100\n");
  assert.equal(read(".env.production"), "VITE_SYNC_API_URL=https://loadms.178-104-51-43.nip.io\n");
  for (const file of [".env.development", ".env.production"]) {
    assert.ok(!/SECRET|TOKEN|KEY|PASSWORD|SIGNUP/i.test(read(file).replace("VITE_SYNC_API_URL", "")), `${file} holds no secret`);
  }
});

// ---------------------------------------------------------------------------
// 4. Server render of the account views with fake engines (Vite SSR)
// ---------------------------------------------------------------------------
{
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  try {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const load = async (file) => (await server.ssrLoadModule(`/${accountDir}/${file}`)).default;
    const AccountAuthForms = await load("AccountAuthForms.jsx");
    const AccountLinkPreview = await load("AccountLinkPreview.jsx");
    const AccountSignedInPanel = await load("AccountSignedInPanel.jsx");
    const html = (component, props) => renderToStaticMarkup(createElement(component, props));

    const guest = html(AccountAuthForms, { engine: {}, initialUsername: "" });
    assert.ok(/<input[^>]*autocomplete="username"/i.test(guest), "rendered: username autocomplete");
    assert.ok(/<input[^>]*type="password"[^>]*autocomplete="current-password"/i.test(guest), "rendered: sign in password");
    assert.ok(guest.includes(">Sign in</button>") && guest.includes(">Create account</button>"));
    assert.ok(!/min-h-(?:[0-9]|10)(?![0-9])\b/.test(guest), "no target under 44 px");

    const link = html(AccountLinkPreview, { engine: { buildLinkPreview: () => new Promise(() => {}) }, username: "ana" });
    assert.ok(link.includes("Link this device to ana"));
    assert.ok(link.includes("Export Data"), "Export is offered while the preview loads");
    assert.ok(link.includes("Comparing this device with the account..."));

    const status = { signedIn: true, linked: true, username: "ana", running: false, waiting: 2, lastSyncAt: null, failures: 0, retryDelayMs: 0, conflicts: 1 };
    const keptEntry = { id: "k1", collection: "programs", recordId: "p1", body: { name: "Push pull" }, source: "sync", at: "2026-10-07T11:58:00.000Z" };
    const signedIn = html(AccountSignedInPanel, {
      engine: { listConflicts: () => [keptEntry] },
      scheduler: {},
      snapshot: { status, lastResult: { status: "needs-confirmation", deletes: 30, live: 40 }, online: true },
      now: Date.parse("2026-10-07T12:00:00.000Z"),
    });
    for (const text of ["Signed in as", "ana", "Sync paused: confirm the deletes below.", "Sync now", "Program: Push pull", "Keep this version", "Discard", "Sign out", "Sign out everywhere", "Change password", "Delete account", "Delete them from the account"]) {
      assert.ok(signedIn.includes(text), `rendered signed-in panel: ${text}`);
    }
    assert.ok(signedIn.includes("This sync would delete 30 records"), "the mass-delete question is shown when the engine asks");
    const offline = html(AccountSignedInPanel, {
      engine: { listConflicts: () => [] },
      scheduler: {},
      snapshot: { status: { ...status, waiting: 0 }, lastResult: null, online: false },
      now: Date.now(),
    });
    assert.ok(offline.includes("Offline: saved on this device, will sync later."));
    const waiting = html(AccountSignedInPanel, {
      engine: { listConflicts: () => [] },
      scheduler: {},
      snapshot: { status, lastResult: { status: "synced" }, online: true },
      now: Date.now(),
    });
    assert.ok(waiting.includes("2 changes waiting."), "the waiting count is shown");
    assert.ok(!offline.includes("Kept versions"), "no kept list when there is nothing kept");
    checks += 1;
  } finally {
    await server.close();
  }
}

// Fix round 1 (decisions H6-31, H6-38, H6-39, H6-41).
{
  const panelSource = read("src/components/account/AccountSignedInPanel.jsx");
  assert.match(panelSource, /function AccountUsernameField[\s\S]{0,200}autoComplete="username"[\s\S]{0,120}readOnly/, "password forms carry the username for password managers");
  assert.equal((panelSource.match(/<AccountUsernameField /g) ?? []).length, 2, "in Change password and Delete account");
  assert.match(panelSource, /daily backups still hold a\s+copy for up to 14 days/, "Delete account says the backups keep a copy");
  assert.match(panelSource, /onClick=\{\(\) => syncNow\(false, true\)\}[\s\S]{0,160}Bring them back from the account/, "the mass-delete question can be declined");
  assert.match(describeMassDelete({ deletes: 30, live: 40 }), /bring them back from the account; until you choose, nothing syncs\./);

  const plain = buildLinkPreviewModel({ ok: true, collections: { programs: { accountOnly: 0, deviceOnly: 0, identical: 5, different: 3 } } });
  const withDefaults = buildLinkPreviewModel({ ok: true, collections: { programs: { accountOnly: 0, deviceOnly: 0, identical: 5, different: 3 } }, defaults: { inAccount: 1, onDevice: 1 } });
  assert.equal(plain.keptOnMerge, 3);
  assert.equal(withDefaults.keptOnMerge, 1, "built-in defaults are not kept aside on Merge");
  assert.equal(withDefaults.defaultInAccount, 1);
  assert.equal(withDefaults.defaultOnDevice, 1);
  assert.ok(!/built-in default/.test(plain.mergeText), "no defaults text when there are none");
  assert.match(withDefaults.mergeText, /1 built-in default you changed on this device keeps this device's version\./);
  assert.match(withDefaults.mergeText, /1 untouched built-in default here takes the account's version; no copy is kept\./);

  assert.match(describeAccountError({ code: "epoch_changed" }), /restored from a backup/);
  const cardSource = read("src/components/account/AccountSyncCard.jsx");
  assert.match(cardSource, /lastError\?\.code === "epoch_changed"/, "the link view says why it asks again");
  checks += 1;
}

console.log(`UI H6 account verification passed (${checks} checks).`);
