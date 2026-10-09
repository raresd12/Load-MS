import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase H6 fix round 1, deploy files (decisions H6-29, H6-31, H6-37, H6-41):
// the hand-run steps in deploy/README.md and the Caddy block must match what
// the server code needs. Text checks only; nothing is deployed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const readme = read("deploy/README.md");
const caddy = read("deploy/Caddyfile.loadms");
const db = read("server/db.mjs");
const envExample = read("deploy/api.env.example");
let checks = 0;

// H6-37: node:sqlite needs no flag only from Node 22.13.
assert.match(readme, /22\.13 or newer/, "the README asks for Node 22.13");
assert.doesNotMatch(readme, /22\.12/, "no step still says 22.12");
assert.match(db, /Node 22\.13/);
assert.doesNotMatch(db, /22\.12/);
checks += 1;

// Update and rollback: a second update or a second rollback must not nest
// the old code inside server.prev / server.bad.
const removePrev = readme.indexOf("rm -rf /opt/loadms/app/server.prev");
const movePrev = readme.indexOf("mv /opt/loadms/app/server /opt/loadms/app/server.prev");
assert.ok(removePrev >= 0 && movePrev > removePrev, "server.prev is removed before the current code moves there");
const removeBad = readme.indexOf("rm -rf /opt/loadms/app/server.bad");
const moveBad = readme.indexOf("mv /opt/loadms/app/server /opt/loadms/app/server.bad");
assert.ok(removeBad >= 0 && moveBad > removeBad, "server.bad is removed before a rollback moves the code there");
checks += 1;

// H6-41: the env file is edited in a terminal, and the placeholder invite code
// is caught before the service starts.
assert.match(readme, /ssh -t SERVER 'editor \/etc\/loadms\/api\.env'/);
assert.match(readme, /grep -q "\^LOADMS_SIGNUP_CODE=replace-with"/);
assert.match(envExample, /^LOADMS_SIGNUP_CODE=replace-with/m, "the example still uses the placeholder the server refuses");
checks += 1;

// H6-31: a restore stamps a new epoch so linked devices relink.
assert.match(readme, /backup\.mjs --rotate-epoch \/opt\/loadms\/data\/loadms\.db/);
assert.doesNotMatch(readme, /come back on the next sync/, "a restore never promises silent recovery");
checks += 1;

// H6-29: Caddy's body cap sits above the API's own 4 MiB push cap.
assert.match(caddy, /^\s*max_size 5MiB$/m);
checks += 1;

// H6-41: deleted accounts stay in the daily backups until they rotate out.
assert.match(readme, /## Deleted accounts and backups/);
assert.match(readme, /still hold it until they rotate out \(14 days/);
checks += 1;

// H6-47: a code rollback across a schema migration never starts on its own
// (db.mjs refuses a newer database), so the README checks the schema first
// and rolls code and database back together, the database before the start.
{
  assert.match(db, /Database schema \$\{version\} is newer than this server/, "the server still refuses a newer database");
  const rollback = readme.slice(readme.indexOf("## Rollback"));
  const check = rollback.indexOf("server.prev/db.mjs");
  const codeOnly = rollback.indexOf("- **Code** (the check says `code only`)");
  const together = rollback.indexOf("- **Code and database together** (the check says `migrated`)");
  assert.ok(check >= 0 && codeOnly > check && together > codeOnly, "the schema check comes before both code recipes");
  assert.match(rollback, /PRAGMA user_version/);
  const recipe = rollback.slice(together, rollback.indexOf("- **Database**"));
  const order = [
    "systemctl stop loadms-api.service",
    "mv /opt/loadms/app/server.prev /opt/loadms/app/server",
    "install -o loadms -g loadms -m 0640 /opt/backups/loadms/",
    "--rotate-epoch",
    "systemctl start loadms-api.service",
  ].map((step) => recipe.indexOf(step));
  assert.ok(order.every((at) => at >= 0), "the combined recipe has every step");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "stop, old code, old database, new epoch, then start");
  assert.doesNotMatch(recipe, /systemctl restart/, "the new code never starts on the restored file");
}
checks += 1;

// Phase H6 fix round 3 (decision H6-49): the operator document covers
// monitoring through health and the journal, the access-log format, and every
// rate, size, quota and in-flight limit with the value the code enforces.
const { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } = await import("../server/app.mjs");
const httpServer = await import("../server/index.mjs");
const { MAX_CONCURRENT_HASHES } = await import("../server/secrets.mjs");
const section = (title) => {
  const start = readme.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `the README has a "${title}" section`);
  const end = readme.indexOf("\n## ", start + 4);
  return readme.slice(start, end < 0 ? undefined : end);
};
const index = read("server/index.mjs");
const unit = read("deploy/loadms-api.service");

{
  const monitoring = section("Monitoring");
  for (const line of [
    "curl -fsS http://127.0.0.1:3100/v1/health",
    "journalctl -u loadms-api",
    "journalctl -u loadms-backup",
    "systemctl list-timers loadms-backup.timer",
    "MemoryCurrent",
    "NRestarts",
    "loadms backup failed",
    "loadms backup written",
  ]) {
    assert.ok(monitoring.includes(line), `Monitoring names ${line}`);
  }
  // The documented access-log line is the one server/index.mjs writes (H6-17).
  assert.match(index, /return `\$\{new Date\(\)\.toISOString\(\)\} \$\{verb\} \$\{safePath\(rawUrl\)\} \$\{status\} \$\{ms\}ms`;/);
  assert.ok(monitoring.includes("`<ISO time> <METHOD> <path without query> <status> <ms>ms`"), "the access-log format is documented");
  assert.match(monitoring, /never holds a body, password, token/);
  for (const status of ["`500`", "`503`", "`429`", "`413`", "`401`"]) {
    assert.ok(monitoring.includes(status), `Monitoring says what ${status} means`);
  }
  assert.match(monitoring, /grep -E " 5\[0-9\]\{2\} \[0-9\]\+ms\$"/);
  assert.match(monitoring, /grep -E " 429 \[0-9\]\+ms\$"/);
  // The messages the monitoring greps for are the ones the code prints.
  assert.match(read("server/backup.mjs"), /loadms backup failed: /);
  assert.match(read("server/backup.mjs"), /loadms backup written: /);
  assert.match(read("server/app.mjs"), /"loadms-api error:"/);
}
checks += 1;

{
  const limits = section("Limits and cost controls");
  const mib = (bytes) => `${bytes / (1024 * 1024)} MiB`;
  const kib = (bytes) => `${bytes / 1024} KiB`;
  const rate = (buckets) => buckets.map((bucket) => `${bucket.max} ${bucket.windowMs === 60_000 ? "a minute" : "an hour"}`).join(", ");
  const expected = [
    "`LOADMS_SIGNUP_CODE`",
    "`LOADMS_MAX_ACCOUNTS`",
    "`LOADMS_TRUST_PROXY=1`",
    `| ${rate(DEFAULT_RATE_LIMITS.auth)} |`,
    `| ${rate(DEFAULT_RATE_LIMITS.signup)} |`,
    `| ${rate(DEFAULT_RATE_LIMITS.sync)} |`,
    `| ${mib(DEFAULT_LIMITS.requestBytes)} (Caddy: 5MiB) |`,
    `| ${kib(DEFAULT_LIMITS.authRequestBytes)} |`,
    `| ${kib(DEFAULT_LIMITS.bodyBytes)} |`,
    `| ${DEFAULT_LIMITS.userBytes / (1024 * 1024)} MB |`,
    `| ${DEFAULT_LIMITS.userRecords.toLocaleString("en-US")} |`,
    `| ${DEFAULT_LIMITS.opsPerPush} |`,
    `| ${DEFAULT_LIMITS.pullLimit} records or ${mib(DEFAULT_LIMITS.pullBytes)} |`,
    `| ${mib(httpServer.DEFAULT_MAX_IN_FLIGHT_BYTES)} in all, ${mib(httpServer.DEFAULT_MAX_USER_IN_FLIGHT_BYTES)} per user |`,
    `| ${mib(httpServer.DEFAULT_MAX_ANON_IN_FLIGHT_BYTES)} in all, ${kib(httpServer.DEFAULT_MAX_IP_IN_FLIGHT_BYTES)} per client address |`,
    `| ${DEFAULT_LIMITS.appliedOpsPerUser.toLocaleString("en-US")} per user, ${DEFAULT_LIMITS.appliedOpsTtlMs / 86_400_000} days |`,
    `| ${MAX_CONCURRENT_HASHES} scrypt hashes at a time |`,
    "`429 rate_limited`",
    "`503 busy` + `Retry-After: 5`",
    "`413 payload_too_large`",
    "op rejected `quota`",
    "op rejected `body_too_large`",
    "`403 signup_closed`",
    "`403 invalid_invite`",
    "`400 too_many_ops`",
  ];
  for (const text of expected) {
    assert.ok(limits.includes(text), `Limits and cost controls lists ${text}`);
  }
  assert.match(caddy, /^\s*max_size 5MiB$/m, "the Caddy cap named in the table");
  assert.match(unit, /^MemoryMax=160M$/m, "the memory cap named in the table");
  assert.ok(limits.includes("`MemoryMax=160M`"));
  assert.match(envExample, /^LOADMS_MAX_ACCOUNTS=50$/m, "the env example and the table agree on the account cap");
  assert.ok(limits.includes("| Accounts | 50 |"));
  assert.match(limits, /a `429` or `503` is\s+temporary/);
  assert.match(limits, /A `quota` rejection leaves the change waiting/);
}
checks += 1;

// H6-12: the operator document says there is no AI proxy.
{
  const rules = section("Rules that are never broken");
  assert.match(rules, /There is \*\*no AI proxy\*\*/);
  assert.match(rules, /never receives Gemini traffic or a\s+Gemini key/);
}
checks += 1;

// H6-49: CLAUDE.md names every H6 decision row and the client sync layer, so
// agents reading it find the current contract and the files that own it.
{
  const guide = read("CLAUDE.md");
  const decisions = read("docs/decisions.md");
  const last = Math.max(...[...decisions.matchAll(/^\| H6-(\d+) \|/gm)].map((match) => Number(match[1])));
  assert.ok(last >= 49, `decisions.md has H6 rows up to H6-${last}`);
  assert.ok(guide.includes(`(H6, decisions H6-1 to H6-${last})`), `CLAUDE.md cites H6-1 to H6-${last}`);
  assert.doesNotMatch(guide, /H6-1 to H6-13\b/, "no stale H6 range");
  for (const name of [
    "src/lib/syncRecords.js",
    "src/lib/syncApi.js",
    "src/lib/syncEngine.js",
    "src/lib/syncSeeds.js",
    "src/lib/accountView.js",
    "src/components/account/*",
    "syncController.js",
    "VITE_SYNC_API_URL",
    "syncConflicts",
    "rpe-tracker.sync-token.v1",
    "rpe-tracker.sync-meta.v1",
    "rpe-tracker.sync-lease.v1",
    "deploy/README.md",
  ]) {
    assert.ok(guide.includes(name), `CLAUDE.md names ${name}`);
  }
  assert.match(guide, /no AI proxy/);
}
checks += 1;

console.log(`Deploy H6 docs verification passed (${checks} checks).`);
