# Load MS sync API: manual deploy and rollback

Decisions H6-1 to H6-49 in `docs/decisions.md`. The API is one Node 22 process
with no npm dependencies (`server/`), behind Caddy on the owner's Hetzner
server. It is deployed **by hand, after review**. No script, fixture or agent
deploys it.

## Rules that are never broken

- The **senlive** unit (`senlive*.service`, its files and its data) is never
  edited, restarted or stopped.
- The **prognoza** site block in `/etc/caddy/Caddyfile` is never edited. The
  Load MS block is **appended** at the end of the file. Nothing else in that
  file changes.
- Caddy is reloaded gracefully (`systemctl reload caddy`) only after
  `caddy validate` passes. It is never restarted.
- No real secret goes into this repository. `/etc/loadms/api.env` exists only
  on the server.
- There is **no AI proxy**. The server never receives Gemini traffic or a
  Gemini key: Gemini stays bring-your-own-key in the browser (decision H6-12),
  and `server/` has no AI route.

## Layout on the server

| Path | Owner / mode | What |
|---|---|---|
| `/opt/loadms/app/server/` | root:root 0755, files 0644 | the API source (copy of `server/`) |
| `/opt/loadms/data/` | loadms:loadms 0750 | `loadms.db` (+ `-wal`, `-shm`) |
| `/opt/backups/loadms/` | loadms:loadms 0750 | daily `loadms-YYYYMMDD-HHMMSS.db`, 14 kept (a deleted account stays in them until they rotate out) |
| `/etc/loadms/api.env` | root:loadms 0640 | settings and the invite code |
| `/etc/systemd/system/loadms-api.service` | root 0644 | the API unit (`MemoryMax=160M`) |
| `/etc/systemd/system/loadms-backup.{service,timer}` | root 0644 | daily backup |

The API listens on `127.0.0.1:3100` only. Caddy serves
`loadms.178-104-51-43.nip.io` (used by the client) and
`loadms.178-104-51-43.sslip.io`.

## First deploy

Run from the repository root on your own machine, then on the server as root.
`SERVER` is the server's SSH alias.

1. Check Node on the server (22.13 or newer: `node:sqlite` needs no flag from
   22.13 on, decision H6-37; the units call
   `/usr/local/bin/node`). If `command -v node` prints another path, change
   `ExecStart` in both service files before copying them.

   ```sh
   ssh SERVER 'node --version; command -v node'
   ```

2. Create the system user and the directories.

   ```sh
   ssh SERVER 'set -e
     id loadms >/dev/null 2>&1 || useradd --system --home-dir /opt/loadms --shell /usr/sbin/nologin loadms
     install -d -o root -g root -m 0755 /opt/loadms /opt/loadms/app
     install -d -o loadms -g loadms -m 0750 /opt/loadms/data /opt/backups/loadms
     install -d -o root -g loadms -m 0750 /etc/loadms'
   ```

3. Copy `server/` (only that folder; `src/`, `dist/` and `.data/` never go).

   ```sh
   tar -czf /tmp/loadms-server.tgz server
   scp /tmp/loadms-server.tgz SERVER:/tmp/
   ssh SERVER 'set -e
     rm -rf /opt/loadms/app/server.new
     mkdir /opt/loadms/app/server.new
     tar -xzf /tmp/loadms-server.tgz -C /opt/loadms/app/server.new --strip-components=1
     chown -R root:root /opt/loadms/app/server.new
     chmod -R u=rwX,go=rX /opt/loadms/app/server.new
     rm -rf /opt/loadms/app/server.prev
     [ ! -d /opt/loadms/app/server ] || mv /opt/loadms/app/server /opt/loadms/app/server.prev
     mv /opt/loadms/app/server.new /opt/loadms/app/server
     rm /tmp/loadms-server.tgz'
   ```

4. Write `/etc/loadms/api.env` from `deploy/api.env.example`: set the real
   Netlify origin and a fresh invite code (`openssl rand -base64 18`). The API
   refuses to start while the code is still the example placeholder (decision
   H6-41). The editor needs a terminal, hence `ssh -t`.

   ```sh
   scp deploy/api.env.example SERVER:/tmp/api.env
   ssh SERVER 'set -e
     install -o root -g loadms -m 0640 /tmp/api.env /etc/loadms/api.env
     rm /tmp/api.env'
   ssh -t SERVER 'editor /etc/loadms/api.env'
   ssh SERVER 'grep -q "^LOADMS_SIGNUP_CODE=replace-with" /etc/loadms/api.env && echo "STOP: the invite code is still the placeholder" || echo "invite code set"'
   ```

5. Install and start the units.

   ```sh
   scp deploy/loadms-api.service deploy/loadms-backup.service deploy/loadms-backup.timer SERVER:/tmp/
   ssh SERVER 'set -e
     install -o root -g root -m 0644 /tmp/loadms-api.service /tmp/loadms-backup.service /tmp/loadms-backup.timer /etc/systemd/system/
     rm /tmp/loadms-api.service /tmp/loadms-backup.service /tmp/loadms-backup.timer
     systemctl daemon-reload
     systemctl enable --now loadms-api.service
     systemctl enable --now loadms-backup.timer
     systemctl --no-pager status loadms-api.service
     curl -fsS http://127.0.0.1:3100/v1/health'
   ```

6. Append the Caddy block, validate, reload gracefully. Keep the copy of the
   old file for the rollback.

   ```sh
   scp deploy/Caddyfile.loadms SERVER:/tmp/
   ssh SERVER 'set -e
     grep -q "loadms.178-104-51-43.nip.io" /etc/caddy/Caddyfile && { echo "block already present"; exit 1; }
     cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-loadms
     cat /tmp/Caddyfile.loadms >> /etc/caddy/Caddyfile
     rm /tmp/Caddyfile.loadms
     caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || { cp -p /etc/caddy/Caddyfile.before-loadms /etc/caddy/Caddyfile; echo "validate failed, restored"; exit 1; }
     systemctl reload caddy'
   ```

7. Health check from outside (the first request may wait a few seconds while
   Caddy gets the certificate).

   ```sh
   curl -fsS https://loadms.178-104-51-43.nip.io/v1/health
   curl -fsS https://loadms.178-104-51-43.sslip.io/v1/health
   curl -si -X OPTIONS https://loadms.178-104-51-43.nip.io/v1/sync/push \
     -H 'Origin: https://sunny-marshmallow-bb5e55.netlify.app' \
     -H 'Access-Control-Request-Method: POST' | head -n 12
   ssh SERVER 'systemctl --no-pager status senlive* | head -n 5; systemctl show loadms-api -p MemoryCurrent'
   ```

   Expect `{"ok":true,"version":"..."}`, a 204 preflight naming the origin,
   senlive still active, and the API's memory well under 80 MB.

8. Run one backup by hand and check it.

   ```sh
   ssh SERVER 'systemctl start loadms-backup.service && ls -l /opt/backups/loadms && systemctl list-timers loadms-backup.timer --no-pager'
   ```

## Monitoring

Everything the API and the backup print goes to the systemd journal; there is
no other log file. Check it after a deploy, an update, and whenever a device
reports sync errors.

```sh
ssh SERVER 'systemctl --no-pager status loadms-api.service loadms-backup.timer
  curl -fsS http://127.0.0.1:3100/v1/health
  systemctl show loadms-api -p MemoryCurrent -p NRestarts
  journalctl -u loadms-api --since "1 hour ago" --no-pager | tail -n 50'
```

- **Health**: `GET /v1/health` answers `{"ok":true,"version":"..."}` with no
  token. Anything else (or a refused connection) means the API is down; read
  `journalctl -u loadms-api -n 100 --no-pager` for the start error (for
  example the placeholder invite code, or "Database schema N is newer than
  this server").
- **Access log**: one line per request, in the form
  `<ISO time> <METHOD> <path without query> <status> <ms>ms`, for example
  `2026-10-09T08:15:02.114Z POST /v1/sync/push 200 41ms` (decision H6-17). It
  never holds a body, password, token, recovery code or query string. What to
  look for:

  ```sh
  ssh SERVER 'journalctl -u loadms-api --since today --no-pager | grep -E " 5[0-9]{2} [0-9]+ms$"'   # 5xx: server faults and 503 busy
  ssh SERVER 'journalctl -u loadms-api --since today --no-pager | grep -E " 429 [0-9]+ms$"'         # rate limited
  ssh SERVER 'journalctl -u loadms-api --since today --no-pager | grep -E "error|failed"'            # loadms-api error / http error lines
  ```

  - `500`: a bug; the `loadms-api error:` line next to it says where.
  - `503`: `busy`, the in-flight body budget was full (see **Limits and cost
    controls**). A few are harmless; many in a row mean a client is flooding
    or the limits are too tight.
  - `429`: a rate limit was hit. Many from sign-in paths mean someone is
    guessing passwords; from sync paths, a device is looping.
  - `413`: a body over its route's cap.
  - `401` after a password change or "Sign out everywhere" is expected.
- **Backups**: the timer runs once a day; each run prints
  `loadms backup written: ...` or `loadms backup failed: ...`.

  ```sh
  ssh SERVER 'systemctl list-timers loadms-backup.timer --no-pager
    systemctl --no-pager status loadms-backup.service | head -n 5
    journalctl -u loadms-backup --since "3 days ago" --no-pager
    ls -lt /opt/backups/loadms | head -n 5'
  ```

  A failed backup shows `Result: exit-code` in the status and a `failed` line
  in the journal; the newest copy should be less than a day old.
- **Memory and disk**: `MemoryCurrent` stays well under the unit's
  `MemoryMax=160M` (about 70 MB is normal); `NRestarts` above 0 means the API
  crashed and was restarted. `du -sh /opt/loadms/data /opt/backups/loadms`
  shows the database and backup sizes.
- **senlive and prognoza** are not watched here; checking them is part of
  their own routine.

## Limits and cost controls

The server is sized for a few people on a shared box. These limits are in
force; the ones marked *env* are set in `/etc/loadms/api.env` (restart the API
after a change), the others are constants in `server/app.mjs`
(`DEFAULT_LIMITS`, `DEFAULT_RATE_LIMITS`), `server/index.mjs`
(`DEFAULT_MAX_*_IN_FLIGHT_BYTES`) and `server/secrets.mjs`
(`MAX_CONCURRENT_HASHES`), and change only with a reviewed code update.

| Control | Limit | Set by | When it is hit |
|---|---|---|---|
| Invite code | needed for sign-up when set | *env* `LOADMS_SIGNUP_CODE` | `403 invalid_invite` |
| Accounts | 50 | *env* `LOADMS_MAX_ACCOUNTS` | `403 signup_closed` |
| Client address for per-IP limits | last `X-Forwarded-For` entry | *env* `LOADMS_TRUST_PROXY=1` | - |
| Auth requests per IP (sign-up, sign-in, sign-out, recover, password, delete) | 10 a minute, 60 an hour | code (H6-12, H6-17) | `429 rate_limited` + `Retry-After` |
| Sign-ups per IP | 5 an hour | code (H6-12) | `429 rate_limited` |
| Sync requests per user (push, pull, account) | 120 a minute | code (H6-12, H6-17) | `429 rate_limited` |
| Push request body | 4 MiB (Caddy: 5MiB) | code (H6-29) | `413 payload_too_large` |
| Any other request body | 16 KiB | code (H6-29) | `413 payload_too_large` |
| One record body | 512 KiB | code (H6-4, H6-14) | op rejected `body_too_large` |
| Bodies per user | 25 MB | code (H6-4, H6-14) | op rejected `quota` (only growth is refused) |
| Records per user, tombstones included | 50,000 | code (H6-4, H6-14) | op rejected `quota` |
| Ops per push | 200 | code (H6-5) | `400 too_many_ops` |
| Pull page | 500 records or 4 MiB | code (H6-15, H6-33) | `more: true`, next page |
| Bodies in flight with a token | 12 MiB in all, 8 MiB per user | code (H6-29, H6-44) | `503 busy` + `Retry-After: 5` |
| Bodies in flight without a token | 1 MiB in all, 64 KiB per client address | code (H6-44) | `503 busy` + `Retry-After: 5` |
| Op log (`applied_ops`) | 10,000 per user, 90 days | code (H6-32) | oldest dropped; a late retry converges by hash |
| Password hashing | 2 scrypt hashes at a time | code (H6-2) | requests wait their turn |
| API memory | `MemoryMax=160M` | `loadms-api.service` | the kernel kills it; systemd restarts it |

What the answers mean for a person using the app: a `429` or `503` is
temporary, and the app retries later on its own (30 s growing to 10 minutes);
nothing on the device is lost. A `quota` rejection leaves the change waiting
on the device and the status shows a sync error until data is removed or the
limit is raised in a code update. `signup_closed` and `invalid_invite` only
affect new accounts.

## Update to a new version

Repeat step 3 (it keeps the previous code in `/opt/loadms/app/server.prev`),
then:

```sh
ssh SERVER 'set -e
  systemctl start loadms-backup.service
  systemctl restart loadms-api.service
  sleep 1
  curl -fsS http://127.0.0.1:3100/v1/health'
```

Database migrations only move forward (`PRAGMA user_version`); the backup
taken just before the restart is the way back.

## Rollback

First check whether the update migrated the database. The previous code
refuses a database whose schema is newer than its own ("Database schema N is
newer than this server"), so after a migration a code-only rollback never
starts: `Restart=on-failure` relaunches it every 5 s and the health check fails.

```sh
ssh SERVER 'runuser -u loadms -- /usr/local/bin/node --input-type=module -e "
  const { SCHEMA_VERSION } = await import(\"/opt/loadms/app/server.prev/db.mjs\");
  const { DatabaseSync } = await import(\"node:sqlite\");
  const data = new DatabaseSync(\"/opt/loadms/data/loadms.db\", { readOnly: true });
  const version = data.prepare(\"PRAGMA user_version\").get().user_version;
  console.log(version > SCHEMA_VERSION ? \"migrated: roll back code and database together\" : \"code only\");"'
```

- **Code** (the check says `code only`): put the previous code back and
  restart the API.

  ```sh
  ssh SERVER 'set -e
    [ -d /opt/loadms/app/server.prev ]
    rm -rf /opt/loadms/app/server.bad
    mv /opt/loadms/app/server /opt/loadms/app/server.bad
    mv /opt/loadms/app/server.prev /opt/loadms/app/server
    systemctl restart loadms-api.service
    curl -fsS http://127.0.0.1:3100/v1/health'
  ```

- **Code and database together** (the check says `migrated`): stop the API,
  put the previous code back, then restore the backup the update step took
  just before its restart (the newest `loadms-YYYYMMDD-HHMMSS.db` from before
  the update), and only then start the API. Starting the new code on the
  restored file would migrate it forward again. Changes synced since the
  update are not in that backup; read the note under **Database** below.

  ```sh
  ssh SERVER 'set -e
    [ -d /opt/loadms/app/server.prev ]
    systemctl stop loadms-api.service
    rm -rf /opt/loadms/app/server.bad
    mv /opt/loadms/app/server /opt/loadms/app/server.bad
    mv /opt/loadms/app/server.prev /opt/loadms/app/server
    mkdir -p /opt/loadms/data/damaged
    mv /opt/loadms/data/loadms.db* /opt/loadms/data/damaged/
    install -o loadms -g loadms -m 0640 /opt/backups/loadms/loadms-YYYYMMDD-HHMMSS.db /opt/loadms/data/loadms.db
    runuser -u loadms -- /usr/local/bin/node /opt/loadms/app/server/backup.mjs --rotate-epoch /opt/loadms/data/loadms.db
    systemctl start loadms-api.service
    curl -fsS http://127.0.0.1:3100/v1/health'
  ```

- **Database** (only if a migration or a bug damaged it): stop the API, keep
  the damaged file, copy the chosen backup in place, start again.

  ```sh
  ssh SERVER 'set -e
    systemctl stop loadms-api.service
    mkdir -p /opt/loadms/data/damaged
    mv /opt/loadms/data/loadms.db* /opt/loadms/data/damaged/
    install -o loadms -g loadms -m 0640 /opt/backups/loadms/loadms-YYYYMMDD-HHMMSS.db /opt/loadms/data/loadms.db
    runuser -u loadms -- /usr/local/bin/node /opt/loadms/app/server/backup.mjs --rotate-epoch /opt/loadms/data/loadms.db
    systemctl start loadms-api.service
    curl -fsS http://127.0.0.1:3100/v1/health'
  ```

  The restored copy is older than what the devices last synced, and the next
  sync does **not** bring the newer changes back by itself. Every backup copy
  carries its own database epoch, and `--rotate-epoch` gives the restored file
  a new one even when the same copy is restored twice (decision H6-31). Each
  device sees that the epoch changed, stops syncing and asks to link again;
  its Merge then sends what it has that the copy lacks, and keeps the other
  version of anything that differs. The data stays on the devices
  (localStorage is the source of truth) until they link again.

- **Remove the whole thing**: restore the Caddyfile and stop the units. The
  data directory and backups stay until removed on purpose.

  ```sh
  ssh SERVER 'set -e
    cp -p /etc/caddy/Caddyfile.before-loadms /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    systemctl reload caddy
    systemctl disable --now loadms-backup.timer loadms-api.service'
  ```

  If other blocks were added to the Caddyfile after Load MS, delete only the
  Load MS block by hand instead of restoring the old copy.

## Deleted accounts and backups

Deleting an account removes it from the live database at once. The daily
copies in `/opt/backups/loadms/` still hold it until they rotate out (14 days
at the default `keep`); the app says so before the account is deleted
(decision H6-41). To remove it sooner, delete the copies made before the
deletion by hand.

## Local development

`npm run api` starts the same server with `--dev`: port 3100 on 127.0.0.1,
the database `.data/loadms-dev.db` (git-ignored, created on demand), origins
`http://127.0.0.1:5173` and `http://localhost:5173`, no invite code. The
fixtures `scripts/verify-server-*.mjs` use in-memory databases and never this
file.
