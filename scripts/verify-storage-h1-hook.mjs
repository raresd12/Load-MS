// H1 Track B: useLocalStorageState status tuple and no fallback write-back on a
// corrupt read. Runs the real hook against a tiny in-process React stub that is
// injected through a module customization hook (no react-dom, no DOM needed).
import assert from "node:assert/strict";
import { register } from "node:module";

const reactStubSource = `
let cells = [];
let cursor = 0;
let pendingEffects = [];
let dirty = false;

export function useState(initial) {
  const index = cursor++;
  if (!(index in cells)) {
    const cell = { value: typeof initial === "function" ? initial() : initial };
    cell.set = (next) => {
      const resolved = typeof next === "function" ? next(cell.value) : next;
      if (Object.is(resolved, cell.value)) return;
      cell.value = resolved;
      dirty = true;
    };
    cells[index] = cell;
  }
  return [cells[index].value, cells[index].set];
}

export function useRef(initial) {
  const index = cursor++;
  if (!(index in cells)) cells[index] = { current: initial };
  return cells[index];
}

export function useCallback(callback) {
  const index = cursor++;
  if (!(index in cells)) cells[index] = callback;
  return cells[index];
}

export function useEffect(effect, deps) {
  const index = cursor++;
  const previous = cells[index];
  const changed =
    !previous ||
    !deps ||
    !previous.deps ||
    deps.length !== previous.deps.length ||
    deps.some((dep, position) => !Object.is(dep, previous.deps[position]));
  cells[index] = { deps };
  if (changed) pendingEffects.push(effect);
}

export function __render(component) {
  let output;
  let passes = 0;
  do {
    dirty = false;
    cursor = 0;
    pendingEffects = [];
    output = component();
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
    passes += 1;
    if (passes > 25) throw new Error("render did not settle");
  } while (dirty);
  return output;
}

export function __reset() {
  cells = [];
  cursor = 0;
  pendingEffects = [];
  dirty = false;
}

export default { useState, useRef, useCallback, useEffect };
`;

const reactStubUrl = `data:text/javascript,${encodeURIComponent(reactStubSource)}`;
const loaderSource = `
const REACT_STUB_URL = ${JSON.stringify(reactStubUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react") {
    return { url: REACT_STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failAllWrites = false;
    this.writes = [];
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failAllWrites) {
      throw new DOMException(`Simulated write failure for ${key}`, "QuotaExceededError");
    }

    this.writes.push(key);
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

function installStorage(localStorage) {
  globalThis.window = { localStorage };
  return localStorage;
}

const originalWarn = console.warn;
console.warn = () => {};

const React = await import("react");
assert.equal(typeof React.__render, "function", "react stub is in place");

const {
  discardCorruptStorageValue,
  getStorageIssues,
  STORAGE_KEYS,
  subscribeStorageWrites,
  useLocalStorageState,
  writeStorage,
} = await import("../src/lib/storage.js");

try {
  // ------------------------------------------------------------------
  // Healthy read: existing behaviour (value read, written back on mount)
  // plus the new status element.
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    storage.setItem(STORAGE_KEYS.sessions, JSON.stringify([{ id: "s1" }]));
    storage.writes = [];
    React.__reset();

    const result = React.__render(() => useLocalStorageState(STORAGE_KEYS.sessions, []));
    assert.equal(result.length, 3, "hook returns [state, setState, status]");
    const [state, setState, status] = result;
    assert.deepEqual(state, [{ id: "s1" }]);
    assert.equal(typeof setState, "function");
    assert.deepEqual(status, {
      readOk: true,
      readError: null,
      lastWriteOk: true,
      lastWriteError: null,
    });
    assert.deepEqual(storage.writes, [STORAGE_KEYS.sessions], "mount write still happens");

    setState((current) => [{ id: "s2" }, ...current]);
    const [nextState, , nextStatus] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.sessions, []),
    );
    assert.deepEqual(nextState, [{ id: "s2" }, { id: "s1" }]);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "s2" }, { id: "s1" }]);
    assert.equal(nextStatus.lastWriteOk, true);
  }

  // ------------------------------------------------------------------
  // Missing key: fallback used and written on mount (unchanged behaviour).
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    React.__reset();
    const [state, , status] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.nextPlans, { none: true }),
    );
    assert.deepEqual(state, { none: true });
    assert.equal(status.readOk, true);
    assert.equal(status.lastWriteOk, true);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.nextPlans)), { none: true });
  }

  // ------------------------------------------------------------------
  // Corrupt read: fallback is NOT written back until setState is called.
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    const corruptRaw = '{"broken":';
    storage.setItem(STORAGE_KEYS.workoutDrafts, corruptRaw);
    storage.writes = [];
    React.__reset();

    const [state, setState, status] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.workoutDrafts, {}),
    );
    assert.deepEqual(state, {});
    assert.equal(status.readOk, false);
    assert.match(status.readError, /could not be read/);
    assert.equal(status.lastWriteOk, null, "no write attempted after a failed read");
    assert.equal(storage.getItem(STORAGE_KEYS.workoutDrafts), corruptRaw, "corrupt value untouched");
    assert.deepEqual(
      storage.writes,
      [`${STORAGE_KEYS.workoutDrafts}.corrupt-1`],
      "only the corrupt copy was written",
    );
    assert.ok(
      getStorageIssues().some(
        (issue) => issue.key === STORAGE_KEYS.workoutDrafts && issue.kind === "read-corrupt",
      ),
      "issue visible through the observable",
    );

    // A re-render without setState still does not write the fallback back.
    React.__render(() => useLocalStorageState(STORAGE_KEYS.workoutDrafts, {}));
    assert.equal(storage.getItem(STORAGE_KEYS.workoutDrafts), corruptRaw);

    // Fix round 2 (decision new-U): setting state does NOT overwrite the
    // unreadable value either. The write is refused, the in-memory state
    // still updates and the status reports the refusal.
    setState({ "p::d::2026-09-18": { status: "in-progress" } });
    const [nextState, , nextStatus] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.workoutDrafts, {}),
    );
    assert.deepEqual(nextState, { "p::d::2026-09-18": { status: "in-progress" } });
    assert.equal(storage.getItem(STORAGE_KEYS.workoutDrafts), corruptRaw, "corrupt value still untouched");
    assert.equal(nextStatus.readOk, false, "read status stays historical");
    assert.equal(nextStatus.lastWriteOk, false, "the refused write is reported");
    assert.match(nextStatus.lastWriteError, /could not be read, so it was not overwritten/);

    // The explicit way out: discarding the unreadable data (copy kept) lets
    // the next state change persist.
    const discard = discardCorruptStorageValue(STORAGE_KEYS.workoutDrafts);
    assert.equal(discard.ok, true);
    assert.equal(discard.discarded, true);
    assert.equal(discard.corruptCopyKey, `${STORAGE_KEYS.workoutDrafts}.corrupt-1`);
    assert.equal(storage.getItem(STORAGE_KEYS.workoutDrafts), null, "key removed");
    assert.equal(storage.getItem(`${STORAGE_KEYS.workoutDrafts}.corrupt-1`), corruptRaw, "copy kept");
    assert.ok(
      !getStorageIssues().some((issue) => issue.key === STORAGE_KEYS.workoutDrafts),
      "read-corrupt issue cleared by the discard",
    );
    setState((current) => ({ ...current, "p::d::2026-09-19": { status: "in-progress" } }));
    const [persistedState, , persistedStatus] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.workoutDrafts, {}),
    );
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.workoutDrafts)), persistedState);
    assert.equal(persistedStatus.lastWriteOk, true);
  }

  // ------------------------------------------------------------------
  // Write failure surfaces through status instead of being swallowed.
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    storage.setItem(STORAGE_KEYS.sessions, JSON.stringify([{ id: "kept" }]));
    storage.failAllWrites = true;
    React.__reset();

    const [, setState, status] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.sessions, []),
    );
    assert.equal(status.readOk, true);
    assert.equal(status.lastWriteOk, false);
    assert.match(status.lastWriteError, /Browser storage is full/);

    setState([{ id: "unsaved" }]);
    const [state, , nextStatus] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.sessions, []),
    );
    assert.deepEqual(state, [{ id: "unsaved" }], "in-memory state still updates");
    assert.equal(nextStatus.lastWriteOk, false);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "kept" }]);

    storage.failAllWrites = false;
    setState([{ id: "saved" }]);
    const [, , recoveredStatus] = React.__render(() =>
      useLocalStorageState(STORAGE_KEYS.sessions, []),
    );
    assert.equal(recoveredStatus.lastWriteOk, true);
    assert.equal(recoveredStatus.lastWriteError, null);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "saved" }]);
  }

  // ------------------------------------------------------------------
  // H4 fix round 1 (decision H4-9): the mount write is not a change. It is
  // still written (stored value unchanged, fallback persisted on a fresh
  // device) but emits no write notification; a setState write does.
  // ------------------------------------------------------------------
  {
    const events = [];
    const unsubscribe = subscribeStorageWrites((event) => events.push(event));

    // Stored data: six hook keys mount like App does, nothing is announced.
    const storage = installStorage(new MemoryLocalStorage());
    const storedSessions = JSON.stringify([{ id: "s1" }]);
    storage.setItem(STORAGE_KEYS.sessions, storedSessions);
    storage.writes = [];
    React.__reset();
    const hookKeys = [
      [STORAGE_KEYS.sessions, []],
      [STORAGE_KEYS.nextPlans, {}],
      [STORAGE_KEYS.setupCues, {}],
      [STORAGE_KEYS.readinessByDate, {}],
      [STORAGE_KEYS.workoutDrafts, {}],
      [STORAGE_KEYS.appUiState, {}],
    ];
    const renderApp = () => hookKeys.map(([key, fallback]) => useLocalStorageState(key, fallback));
    let hooks = React.__render(renderApp);
    assert.deepEqual(events, [], "mounting the hooks emits no write event");
    assert.equal(storage.getItem(STORAGE_KEYS.sessions), storedSessions, "stored value unchanged by the mount");
    assert.deepEqual(
      [...storage.writes].sort(),
      hookKeys.map(([key]) => key).sort(),
      "the mount write itself still happens for every hook key",
    );
    assert.equal(storage.getItem(STORAGE_KEYS.nextPlans), "{}", "fallback persisted on a fresh key");
    hooks.forEach(([, , status]) => assert.equal(status.lastWriteOk, true));

    // A re-render without a change writes nothing and announces nothing.
    storage.writes = [];
    hooks = React.__render(renderApp);
    assert.deepEqual(storage.writes, []);
    assert.deepEqual(events, []);

    // A change made through setState is announced, once, for its key only.
    hooks[0][1]((current) => [{ id: "s2" }, ...current]);
    hooks = React.__render(renderApp);
    assert.equal(events.length, 1, "a setState write notifies");
    assert.deepEqual([...events[0].keys], [STORAGE_KEYS.sessions]);
    assert.equal(events[0].source, "local");
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "s2" }, { id: "s1" }]);

    // Later changes keep notifying (the quiet write is the mount write only).
    hooks[1][1]({ "day-1": { id: "plan" } });
    React.__render(renderApp);
    assert.equal(events.length, 2);
    assert.deepEqual([...events[1].keys], [STORAGE_KEYS.nextPlans]);

    // writeStorage: notify defaults to on; only an explicit false is quiet.
    events.length = 0;
    assert.deepEqual(writeStorage(STORAGE_KEYS.setupCues, { a: 1 }), { ok: true });
    assert.deepEqual(writeStorage(STORAGE_KEYS.setupCues, { a: 2 }, { notify: undefined }), { ok: true });
    assert.equal(events.length, 2);
    assert.deepEqual(writeStorage(STORAGE_KEYS.setupCues, { a: 3 }, { notify: false }), { ok: true });
    assert.equal(events.length, 2, "notify: false writes quietly");
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.setupCues)), { a: 3 });

    unsubscribe();
  }

  console.warn = originalWarn;
  console.log("Storage H1 hook verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
