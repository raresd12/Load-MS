import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson, contentHash } from "../server/canonical.mjs";
import { SYNCABLE_COLLECTIONS } from "../server/collections.mjs";

// H6 Track A: the server's own copies stay equal to the client's (decisions
// H6-1, H6-4, H6-5): the syncable collection list, and the canonical JSON the
// content hash is computed from. Also: server/ never imports src/ and stays
// free of npm dependencies.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// localStorage is not touched by these imports, but storage.js expects window.
globalThis.window ??= { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
const { getSyncableCollections } = await import("../src/lib/repository.js");

assert.deepEqual(
  [...SYNCABLE_COLLECTIONS],
  getSyncableCollections().map((collection) => collection.name),
  "server/collections.mjs equals getSyncableCollections() names, in order",
);
assert.equal(SYNCABLE_COLLECTIONS.length, 15);
assert.ok(Object.isFrozen(SYNCABLE_COLLECTIONS));
for (const name of ["appUiState", "programStorageMeta", "activeProgramId"]) {
  assert.ok(!SYNCABLE_COLLECTIONS.includes(name), `${name} stays per device (H4-4)`);
}

// ---- server/ is self-contained ------------------------------------------------------------
const serverDir = path.join(root, "server");
const builtins = new Set(["crypto", "fs", "http", "os", "path", "sqlite", "url", "child_process"]);
for (const file of readdirSync(serverDir).filter((name) => name.endsWith(".mjs"))) {
  const source = readFileSync(path.join(serverDir, file), "utf8");
  for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (specifier.startsWith("node:")) {
      assert.ok(builtins.has(specifier.slice(5)), `${file}: ${specifier} is an allowed built-in`);
    } else {
      assert.match(specifier, /^\.\/[\w.-]+\.mjs$/, `${file} imports only node: built-ins and server/ siblings, not ${specifier}`);
    }
  }
  assert.ok(!/\bsrc\//.test(source.replace(/\/\/.*$/gm, "")), `${file} never references src/ in code`);
  // H6-12: there is no AI proxy. No server file names an AI provider or its
  // endpoint, so Gemini traffic and keys never reach the server.
  for (const marker of [/gemini/i, /generativelanguage/i, /googleapis/i, /openai/i, /anthropic/i, /x-goog-api-key/i, /\bai\b\//i]) {
    assert.ok(!marker.test(source), `${file} has no AI provider marker ${marker}`);
  }
}

// H6-12: the route table holds only health, auth, account and sync routes.
{
  const app = readFileSync(path.join(serverDir, "app.mjs"), "utf8");
  const routes = [...app.matchAll(/\["((?:GET|POST) \/v1\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(routes, [
    "GET /v1/health",
    "POST /v1/auth/signup",
    "POST /v1/auth/signin",
    "POST /v1/auth/signout",
    "POST /v1/auth/signout-all",
    "POST /v1/auth/recover",
    "POST /v1/auth/password",
    "GET /v1/account",
    "POST /v1/account/delete",
    "POST /v1/sync/push",
    "GET /v1/sync/pull",
  ], "the API has exactly these routes; none proxies an AI provider");
}

// ---- canonical JSON is byte-identical to the client's -----------------------------------------
const samples = [
  null,
  0,
  -0,
  1.5e21,
  "plain",
  "quote \" backslash \\ newline \n tab \t \u0000   é 😀",
  true,
  [],
  {},
  [1, "2", null, true, { b: 1, a: 2 }],
  { z: { y: { x: [3, 2, 1] } }, a: undefined, m: [undefined, () => 1, NaN, Infinity] },
  { 10: "ten", 2: "two", b: "bee", A: "ay", _: "under", "": "empty", é: "e acute" },
  { when: new Date(Date.UTC(2026, 9, 7, 12, 30, 0)) },
  {
    id: "session-1",
    programId: "athletic-bodybuilding-rpe",
    sets: [{ reps: 8, weight: 62.5, rpe: 8, programExerciseId: "day-1-ex-1" }],
    readiness: { sleep: 4, soreness: 2, stress: 3 },
  },
];

const clientPath = path.join(root, "src", "lib", "syncRecords.js");
if (!existsSync(clientPath)) {
  console.log("verify-server-contract: note: src/lib/syncRecords.js is missing (Track B), the canonical JSON comparison is skipped");
} else {
  const client = await import(pathToFileURL(clientPath).href);
  const clientCanonical = client.canonicalJson ?? client.canonicalJSON ?? client.toCanonicalJson;
  assert.equal(
    typeof clientCanonical,
    "function",
    `src/lib/syncRecords.js exports canonicalJson (exports: ${Object.keys(client).join(", ")})`,
  );
  for (const sample of samples) {
    assert.equal(clientCanonical(sample), canonicalJson(sample), `canonical JSON matches for ${JSON.stringify(sample)?.slice(0, 60)}`);
  }

  // The content hash too, when the client exports it (SHA-256 hex through
  // crypto.subtle on the client, node:crypto on the server).
  if (typeof client.contentHash === "function") {
    for (const sample of samples.filter((value) => value !== undefined)) {
      assert.equal(await client.contentHash(sample), contentHash(sample, false), "content hash matches");
    }
  }
  if (typeof client.DELETED_HASH === "string") {
    assert.equal(client.DELETED_HASH, contentHash(null, true), "tombstone hash matches");
  }
}

console.log("verify-server-contract: ok");
