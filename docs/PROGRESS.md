# Build Progress

Plain record of what has been built, which requirements it covers, decisions made, and measured numbers. Written for the teammate writing the project report.

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Scaffold | Done (Docker verified 2026-10-11) |
| 1 | Core authentication | Done 2026-10-11 (FR-A6 partial until Phases 3 and 6) |
| 2 | Second factors and recovery | Done 2026-10-17 (FR-A10 and FR-A13 PARTIAL until Phases 4 and 6) |
| 3 | Authorization and audit logs | Done 2026-10-24 (sync audit mode; FR-Z1, L3, L4 PARTIAL until Phases 4 and 6; queue mode = future work) |
| 4 | Sessions, token, mock portal | Done 2026-10-26 (LITE scope; branch `phase4-lite`, merged after the final full run) |
| 5 | Peak-load core | Done 2026-10-26 (branch `phase5`; policy caching moved to Phase 8) |
| 6 | Admin console | Done 2026-10-26 (branch `phase6`) |
| 7 | P1 features | Not started |
| 8 | Load, clustering, measurement | Not started |
| 9 | Hardening and documentation | Not started |
| 10 | FreeRADIUS | Not started |

## Project decisions (apply to all phases)

| Date | Decision | Reason |
|---|---|---|
| 2026-10-11 | Login OTP/TOTP is required **only for accounts with 2FA enabled** (admins always, FR-A13). Phase 7's risk score (FR-A11) can still require an OTP for a risky login. | The spec allowed both readings (acceptance #1 vs. FR-A11); the developer chose this. |
| 2026-10-11 | One active row in `policies`, with every change copied to `policy_history`. Access windows are their own table (`access_windows`), not policy rows. | Matches the data model in SPEC §5; keeps policy reads to a single row. |
| 2026-10-11 | Build order follows CLAUDE.md phases (audit log in Phase 3, after second factors in Phase 2), not the SPEC week-1 list. | CLAUDE.md is the working order; all items are still built. |
| 2026-10-11 | Phase 1 covers FR-A1, A3 to A6. Password reset (FR-A9) is entirely Phase 2. CLAUDE.md said "A9 partly" for Phase 1; that wording was wrong and has been corrected. | Developer confirmed. |
| 2026-10-11 | Only students self-register (checked against `student_records`). Staff and admin accounts come from the seed. | The spec has no staff registry to validate against. |
| 2026-10-11 | Every phase's tests include integration tests against the real PostgreSQL and Redis from docker compose, not only stand-ins. Each phase's schema and endpoint plan is approved before building. | Developer requirement. |
| 2026-10-11 | `package-lock.json` is always regenerated inside `node:24-slim` (see README "Changing dependencies"). | Keeps `npm ci` in the Docker build working (see Phase 0 fix). |
| 2026-10-17 | New packages: check `npm view <pkg> time` (and Docker Hub tags for images); nothing published in the last 14 days; pin exact versions so a later lock regeneration cannot pull in a newer release. | Developer requirement (Phase 2). |
| 2026-10-17 | Phases are built in sub-steps, one commit each, with the full `npm test` run after each. | Developer requirement (Phase 2). |
| 2026-10-24 | While developing, run only the test files that were touched; run the full suite once at the end of a phase and report per-suite times. | Developer requirement: a full run took ~23 min on the loaded machine. |
| 2026-10-24 | Git: backend commits go to `main` (fast-forwarded and pushed); the developer's UI work lives on `ui-polish` and is never staged by the assistant. Stage named files only, never `git add -A`. `.env` is not tracked (`git ls-files` lists only `.env.example`). | Developer requirement. |
| 2026-10-24 | Audit log runs in **sync mode only** (`AUDIT_MODE=sync`). The queue mode (Redis Stream + single writer) is designed and prototyped on branch `audit-queue-experimental`, **not enabled**: future work. Nothing was added to docker-compose. | Developer decision (keep Phase 3 small). |

## Open items handed to later phases

| For phase | Item |
|---|---|
| ~~3~~ | ~~Audit-log admin unlocks and all Phase 1/2 events~~: **done in Phase 3** (see Phase 3 section). |
| ~~4~~ | ~~Audit events for sign-out, sign-out-everywhere and session revocation; session records (FR-L2). Protect the portal routes with `requirePermission` (FR-Z1).~~ **Done in Phase 4.** |
| ~~6~~ | **Done in Phase 6.** Admin console screens for the audit log: "Verify integrity" button (FR-L3), logs viewer with filters and CSV export (FR-L4), using the existing `verifyChain`, `iterateRows` and `csv` modules. Policy/role/permission editing UI calling `adminChangeService` (FR-Z5). |
| 8 | **Measure the audit cost on the login path** (sync mode: every login waits on the chain's advisory lock). `calibrate` should report login latency/throughput with the audit write. If it is a bottleneck, the queue-mode prototype (branch `audit-queue-experimental`) is the planned remedy; Redis AOF (`appendfsync everysec`, with a volume) would then be needed and its cost measured too. |
| 9 | A limited application database role that cannot `ALTER TABLE auth_logs DISABLE TRIGGER`: today the app connects as the table owner, who can switch the append-only triggers off (the hash chain still detects any change made that way). |
| 9 | **Known limit of the outside anchor.** The anchor (latest seq + hash, in Redis) catches deletion of the newest rows only **until the app writes past the old anchored position**: new events link correctly to the shortened chain, and the anchor then moves forward to the new head, so the deletion is no longer visible. Run `audit verify` regularly (Phase 6 button, or a scheduled job) to narrow that window; a stronger fix is an append-only history of anchors kept outside the database (for example periodic anchors written to a file or another system). |
| ~~4~~ | ~~**Delete the interim account ticket** and use the JWT session, with a "signed in recently" check.~~ **Done in Phase 4.** |
| ~~4~~ | ~~FR-A10 / reset: revoke the user's **sessions** after a password reset or change.~~ **Done in Phase 4.** |
| 9 | CSRF tokens stay bound to the pre-session cookie (not the JWT `jti`); see the Phase 4 decision. Revisit with HTTPS in Phase 9. |
| ~~3/4/6~~ | ~~Put `requireAdmin2FA` in front of every `/admin/*` route (FR-A13).~~ **Done in Phase 6.** |
| 8 | Cache the `policies` row **with invalidation on change** (moved from Phase 5): measure the per-request read in `calibrate` first; cache only if it matters. Tests change the row directly in the database, so a cache needs cross-process invalidation. |
| ~~5~~ | ~~Front-end exponential backoff on 429/503.~~ **Done in Phase 5.** |
| ~~5~~ | ~~Per-IP and per-account rate limits on the sign-in and recovery endpoints.~~ **Done in Phase 5.** |
| 5, 8 | **Email delivery in the request path** (sign-in OTP is sent inside `POST /auth/login`) is a peak-load concern: a slow SMTP server slows logins. Revisit (queue, or send after responding) and measure. |
| ~~6~~ | **Done in Phase 6.** Admin console unlock button and `/admin/users/:id/unlock`, calling the existing `unlockUser` service; a 2FA reset button calling `resetTwoFactor`; dashboard counters from `cg:metrics:*` in Redis. |
| 7 | Enforce email verification (FR-A2); `users.email_verified` already exists and is `false` for new sign-ups. |
| 8 | `calibrate` must include the **OTP step time** (send + verify) as well as bcrypt and DB time. |
| 9 | Check the registration privacy notice wording against the Nigeria Data Protection Act 2023 (NFR-5), **including the Phase 3 sentence that full IP addresses are kept in the tamper-evident security log**. |
| Future | Staff-specific services (staff currently get the same three portal services as students). |
| 8, 9 | **Unexplained "fetch failed" glitch (seen 2026-10-17).** During the Phase 2 end-to-end script against the running containers, the first HTTP request after several `docker compose exec` CLI calls twice failed client-side with `fetch failed`. The app logged no such request and never restarted; the same requests succeeded when re-run seconds later. A 6.5 s idle keep-alive test did not reproduce it. Suspected: Docker Desktop port forwarding on the Windows host, not the app. Watch for it in the Phase 8 load tests (it would show up as connection errors, not HTTP errors) and record whether it reappears. |

---

## Phase 0: Scaffold (2026-10-11)

### What was built
- **Docker Compose** with three services: `app` (Node 24 LTS), `postgres` (17), `redis` (8). PostgreSQL and Redis have healthchecks; the app waits for both to be healthy, runs migrations, then starts. Redis requires a password. Database ports are bound to `127.0.0.1` only.
- **Config loader** (`app/src/config.js`): reads environment variables (and `.env` if present), validates them, and refuses to start with a list of every problem.
- **Health endpoint** `GET /health`: checks PostgreSQL (`select 1`) and Redis (`PING`), each with a timeout. 200 + `"ok"` if both answer, 503 + `"degraded"` otherwise. The response says which dependency failed but never includes error details (those go to the log).
- **Logging** with pino (JSON). Each request gets an id, returned in the `X-Request-Id` header. Passwords, OTPs, tokens, TOTP secrets, cookies, and `Authorization` headers are redacted to `[REDACTED]`.
- **Error handler**: unknown routes give a JSON 404; any error gives a generic message (`"Internal Server Error"`, `"Bad Request"`) plus the request id, never a stack trace.
- **Security headers** with helmet from day one (CSP, `nosniff`, no `X-Powered-By`, etc.).
- **Migrations** set up with knex (`db/migrations/`, `npm run migrate`). No tables yet; the schema comes in Phase 1.
- **Graceful shutdown** on SIGTERM/SIGINT (stops accepting requests, closes DB and Redis).
- npm scripts `dev`, `start`, `test`, `migrate`, `seed`, `loadtest`, `calibrate`. `loadtest` and `calibrate` print "not implemented yet (Phase 8)" and exit with an error, so they cannot be mistaken for real results.

### Requirements covered
- **NFR-8** (reliability): `/health`, graceful errors, no stack traces to users.
- **NFR-3** (secrets in env vars): `.env.example` provided, `.env` git-ignored.
- **NFR-1** (partly): helmet security headers. Input validation comes with the first input-taking routes in Phase 1.
- **NFR-9** (partly): `docker compose up` starts app, PostgreSQL, and Redis. Seeding comes in Phase 1.
- **NFR-11** (started): jest + supertest suite.
- Security rule "never log passwords, OTPs, tokens, or secrets": enforced by log redaction and tested.

### Decisions
- **Express 5** (current major): async route errors reach the error handler automatically.
- **ioredis 5.9.x, not 6.0.** ioredis 6 (released July 2026) switches to the RESP3 protocol by default. The Redis rate-limit store used in Phase 5 sends raw commands, so the mature 5.x line avoids compatibility surprises. Revisit if needed.
- **knex** for migrations and queries (parameterized by default).
- **Debian-slim Node image** instead of Alpine so bcrypt's native module installs cleanly in Phase 1.
- **App factory with injected dependencies** (`createApp({ config, logger, db, redis })`): tests run without real databases, and each cluster worker (Phase 8) creates its own connections.
- **`UV_THREADPOOL_SIZE`** is configurable through `.env` and logged at startup. It has to be set in the environment before Node starts; it cannot be changed from code later.
- Log redaction does not hide a generic `code` field, because that would hide error codes like `ECONNREFUSED`. Fields carrying OTPs must be named `otp`, `otpCode`, or `totpCode` (all redacted).

### Tests (run 2026-10-11, all passing: 4 suites, 20 tests; rerun after the lock-file fix, still 20/20)
- `tests/config.test.js`: defaults, required variables, invalid values rejected, `UV_THREADPOOL_SIZE` read.
- `tests/health.test.js`: 200 when healthy; 503 when PostgreSQL or Redis is down; a hanging dependency times out; error text is not leaked.
- `tests/errors.test.js`: JSON 404, generic 400 for malformed JSON, generic 500 with no stack trace; helmet headers present.
- `tests/logger.test.js`: passwords, OTPs, tokens, TOTP secrets, cookies, and auth headers are redacted; error codes stay readable.

The tests use in-memory fakes for PostgreSQL and Redis, so they need no running database.

### Verified vs. not yet verified
- **First pass (no Docker on the machine):** test suite passed. The real server started and `/health` returned **503** with PostgreSQL and Redis absent, as intended.
- **Docker verification (2026-10-11), after the lock-file fix below:** see "Docker verification" for the exact commands and output. Phase 0's "done when" check is met.

### Fix: package-lock.json out of sync with the Docker image
**Problem.** `docker compose up --build` failed at `npm ci` in the Dockerfile:
```
npm error `npm ci` can only install packages when your package.json and package-lock.json ... are in sync.
npm error Missing: @emnapi/core@1.11.3 from lock file
npm error Missing: @emnapi/runtime@1.11.3 from lock file
npm error Invalid: lock file's @emnapi/wasi-threads@1.2.1 does not satisfy @emnapi/wasi-threads@1.2.3
npm error Missing: @emnapi/core@1.10.0 from lock file
npm error Missing: @emnapi/runtime@1.10.0 from lock file
npm error Missing: @emnapi/wasi-threads@1.2.1 from lock file
```
**Cause.** The lock file was generated on Windows with npm 11.6.2. The `@emnapi/*` packages are optional, platform-specific dependencies pulled in by jest (via `unrs-resolver`). The Windows install left them out, but the image's npm (11.19.0, on Linux) expects them in the lock file.

**Fix.** Regenerated the lock file inside the same image the Dockerfile uses (`node:24-slim` = **Node v24.21.0, npm 11.19.0**). The Dockerfile still uses `npm ci`.
```bash
docker run --rm node:24-slim sh -c 'node --version && npm --version'    # v24.21.0 / 11.19.0
# regenerate from package.json only, in a scratch dir inside the container, copy the lock back:
docker run --rm -v "<repo>:/src" node:24-slim sh -c \
  'mkdir /w && cp /src/package.json /w/ && cd /w && npm install --package-lock-only --no-audit --no-fund && cp package-lock.json /src/package-lock.json'
```
**Checked afterwards:**
- `npm ci --omit=dev` (what the Dockerfile runs) in `node:24-slim`: added 122 packages, no errors.
- Full `npm ci` in `node:24-slim`: added 434 packages, no errors.
- Host `npm ci` on Windows (npm 11.6.2) with the new lock: added 434 packages and did not rewrite the lock file. `npm test`: 4 suites, 20 tests passed.
- Direct dependency versions unchanged, except **ioredis 5.9.3 -> 5.11.1** (still inside `^5.9.3` and still the 5.x line, so the RESP2 reasoning above holds).
- `@emnapi/*`, `unrs-resolver`, and `@parcel/watcher` are marked dev-only in the lock file, so they are not in the production image.

**Rule from now on:** when dependencies change, regenerate `package-lock.json` inside `node:24-slim` (command above), not with the host's npm, so it stays in sync with the image.

### Docker verification (2026-10-11)
Docker 29.8.2, Docker Compose v5.5.1.
```bash
docker compose up --build -d
```
Image built (including `npm ci --omit=dev`); postgres and redis became healthy, then the app started. Migrations ran ("Already up to date": no migrations exist yet).

```
$ docker compose ps
NAME                     IMAGE                STATUS
auth-system-app-1        auth-system-app      Up 37 seconds (healthy)       0.0.0.0:3000->3000/tcp
auth-system-postgres-1   postgres:17-alpine   Up About a minute (healthy)   127.0.0.1:5432->5432/tcp
auth-system-redis-1      redis:8-alpine       Up About a minute (healthy)   127.0.0.1:6379->6379/tcp

$ curl -i http://localhost:3000/health
HTTP/1.1 200 OK
{"status":"ok","uptime_s":33,"checks":{"postgres":{"status":"ok","latency_ms":7.498338},"redis":{"status":"ok","latency_ms":6.156361}}}
```
Failure path, checked live:
```
$ docker compose stop redis && curl http://localhost:3000/health
HTTP 503  {"status":"degraded",...,"checks":{"postgres":{"status":"ok",...},"redis":{"status":"error"}}}
$ docker compose start redis && curl http://localhost:3000/health
HTTP 200  {"status":"ok",...}
```
The app logged one `redis connection error` and one `redis reconnected` (no log flood while Redis was down).

**Observations (not changed):**
- The container reports `nodeEnv: "development"` because `.env` sets `NODE_ENV=development`, and `env_file` overrides the Dockerfile's `NODE_ENV=production`. That is fine for local development; set `NODE_ENV=production` in `.env` for a production-like run.
- `npx knex` at container start prints an "npm update available" notice. It is harmless log noise.

### Commands
```bash
npm install
npm test
cp .env.example .env && docker compose up --build
curl http://localhost:3000/health
```

### What to screenshot
- `docker compose ps` showing `app`, `postgres`, `redis` all `healthy`.
- Output of `curl http://localhost:3000/health` (200, `"status":"ok"`).
- `npm test` summary (4 suites, 20 tests passing).

### Measured numbers
None yet. Measurement starts in Phase 1 (bcrypt cost) and Phase 8 (calibration).

---

## Phase 1: Core authentication (2026-10-11)

### What was built
- **Database schema** (4 knex migrations, plain SQL):
  - `roles`: student, staff, guest, admin.
  - `student_records`: the registry that sign-ups are checked against.
  - `users`: every column from SPEC §5. The 2FA columns stay unused until Phase 2.
  - `policies`: exactly one row, enforced by `CHECK (id = 1)`.
  - CHECK constraints make the database itself reject bad data, even if the app is bypassed. Matric IDs must be upper-case and trimmed, emails lower-case and unique, levels 100–600, `failed_attempts ≥ 0`, and policy values within ranges.
- **Registration** `POST /auth/register` (students only):
  - The matric number must exist in `student_records` and not already have an account. The email must not be in use.
  - All three rejections return **one identical message**, so registration cannot be used to find out who has an account.
  - Level and faculty are copied from the registry.
  - A consent checkbox with a privacy notice is required.
- **Password policy** (FR-A3):
  - Minimum length, uppercase and special-character rules are read from the live `policies` row.
  - A blocklist of about 200 common passwords is checked case-insensitively. It includes ones that pass the other rules, such as `Password@123` and `Nigeria@123`.
  - Passwords over 72 bytes are rejected, because bcrypt silently ignores anything after byte 72.
  - Every failing rule is reported at once.
- **bcrypt hashing** (FR-A4): async API only (runs on the libuv thread pool), cost from `BCRYPT_COST`, chosen by measurement (below).
- **Login** `POST /auth/login` with a matric/staff ID or email (FR-A5):
  - Every failure (wrong password, unknown user, inactive account, locked account) gets a **byte-identical** 401: *"Invalid ID or password. After repeated failures, sign-in is paused for 15 minutes."*
  - For unknown, inactive and locked accounts, the app still compares against a **dummy hash at the same cost as real hashes**, so response time does not reveal whether an account exists.
- **Temporary lockout** (FR-A6, FR-P5): rules below.
- **Admin unlock through a CLI** (FR-A6, partial):
  - `npm run admin -- unlock <ID or email>`, `npm run admin -- status <ID or email>`, `npm run admin -- locked`.
  - Inside Docker: `docker compose exec app npm run admin -- unlock SCI/2025/0061`.
- **Pages:** `/login` and `/register` are server-rendered with EJS (all output escaped), mobile-first, with no front-end framework. About 2 KB of CSS and 3 KB of JS submit the forms as JSON. `/` redirects to `/login`.
- **CSRF protection** (NFR-2): `csrf-csrf` double-submit cookie.
  - Each visitor gets a random HttpOnly, SameSite=Strict pre-session cookie, and the CSRF token is bound to it. This also blocks login CSRF.
  - Cookies get `Secure` and the `__Host-` prefix when `COOKIE_SECURE=true` (HTTPS, Phase 9).
- **Input validation** (NFR-1) with express-validator. Errors never echo submitted values. All database access goes through knex with bound parameters.
- **Seed** (`npm run seed`):
  - 2,000 deterministic fake students across 5 faculties and levels 100–500, with matric numbers like `SCI/2022/0001`.
  - 1,500 have accounts and 500 are left free for the live registration demo. Both counts are configurable (`SEED_REGISTERED_STUDENTS`, `SEED_FREE_STUDENTS`).
  - Plus one staff account (`STAFF0001`) and one admin (`ADMIN0001`).
  - Passwords come from `.env` and must pass the password policy.
  - **Accounts are hashed at the real cost**, so later load tests and calibration measure realistic login times.
  - Safe to re-run: existing rows and passwords are left alone.
- **`npm run bench:bcrypt`**: measures bcrypt time at costs 10, 11 and 12.
- A database connection-pool timeout now returns **503** (overloaded) instead of 500.

### Requirements covered
| ID | Status | Notes |
|---|---|---|
| FR-A1 | Done | Students only; staff and admin are seeded. Email verification is FR-A2 (Phase 7). |
| FR-A3 | Done | Policy rules from the DB row, plus the blocklist. |
| FR-A4 | Done | bcrypt, cost 10 by measurement. Low cost allowed only when `NODE_ENV=test`. |
| FR-A5 | Done | Identical 401 for every failure, plus same-cost dummy hash. |
| FR-A6 | **Partial** | Temporary lockout fully works. Admin unlock exists **only as a CLI**. **TODO Phase 3:** write each unlock (and lockouts) to the tamper-evident audit log. **TODO Phase 6:** unlock from the admin console. |
| FR-P5 | Done for login | Only credential failures count; tested with simulated bcrypt failure and real DB pool exhaustion. |
| NFR-1, NFR-2 | Partly | Validation, escaping, parameterized queries, CSRF. HTTPS is Phase 9. |
| NFR-5 | Partly | Minimal data, consent notice. Wording still to be checked against NDPA 2023 (Phase 9). |
| NFR-9 | Partly | Seed script for 2,000 students. |

### Lockout rules, exactly as built
1. Only a **wrong password for an existing, active, unlocked account** counts. Validation errors (400), missing CSRF token (403), database timeouts (503), bcrypt or other server errors (500) never count (FR-P5).
2. The failure is counted with a single atomic `UPDATE … RETURNING` in PostgreSQL. Concurrent wrong attempts queue on the row lock, and once the account is locked, further concurrent attempts are not counted. In the test, **10 simultaneous wrong logins gave exactly 5 failures and 1 lockout event.**
3. Reaching `max_attempts` (default 5) sets `locked_until = now() + lockout_minutes` (default 15). Both values come from the live `policies` row, so a change applies to the next login with no restart (tested with `max_attempts = 3`).
4. **While locked, the password is not checked at all**, and attempts neither count nor extend the lock.
5. When the lock expires, the next failure starts the count from 1 (not 6). A successful login resets it to 0.
6. Times are compared on the database clock (`now()`), so clock differences between the app and the database don't matter.

### Trade-off: lockout as a denial-of-service risk
Account lockout helps against password guessing but can be turned into an attack. Anyone who knows a matric number (they are not secret) can type 5 wrong passwords and lock that student out for 15 minutes, for example just before a fees deadline. This design limits the damage but does not remove it:
- **Locks are temporary** (15 minutes by default, set by the admin) and **attempts during a lock do not extend it**. An attacker must keep sending a burst every 15 minutes to keep one account locked; they cannot lock it once and walk away.
- **Admin unlock** clears a lock immediately.
- **Not handled yet:** an attacker can still keep re-locking a chosen account, or lock many accounts. Phase 5's per-IP and per-account rate limits (FR-P4) slow this down, and Phase 7's suspicious-activity panel (FR-D5) makes it visible. Other options, such as a CAPTCHA after failures, or locking per (account, IP) pair instead of per account, are **not in the spec** and were not built.
- The opposite choice (counting attempts during a lock, or extending the lock) would be stronger against guessing but would make this denial-of-service much easier, so it was not used.

### bcrypt cost: measured timings (FR-A4)
Measured with `npm run bench:bcrypt` **inside the app container** (Node v24.21.0, Linux under WSL2, Intel Core i7-6600U @ 2.60 GHz, 4 logical CPUs, `UV_THREADPOOL_SIZE=4`). One operation at a time, so these are single-login times, not throughput. **Compare** is what a login does; **hash** is what registration does.

| Cost | Run A: hash / compare median (ms) | Run B: hash / compare median (ms) | Run C: hash / compare median (ms) | Compare p95, runs A / B / C (ms) |
|---|---|---|---|---|
| **10** | 192.0 / 114.3 | 192.6 / 164.3 | 126.3 / 114.5 | 202.7 / 207.3 / 193.3 |
| **11** | 187.2 / 180.2 | 329.9 / 202.7 | 222.9 / 216.0 | 314.4 / 315.9 / 394.2 |
| **12** | 386.3 / 378.5 | 497.4 / 418.4 | 404.2 / 1238.5 | 608.8 / 683.3 / 1720.8 |

- Run A: 20 samples per cost, measured while a large `npm ci` was running on the same machine. **It is not reliable** (cost 10 hashing came out slower than cost 11) and is shown only for completeness.
- Runs B and C: 30 samples per cost, no other heavy work running. The laptop's background load still varies, so medians move by up to about 50% between runs. The cost-12 compare median of 1,238 ms in run C is an outlier caused by a load spike.
- **Consistent pattern:** each +1 in cost roughly doubles the time. A login at cost 10 takes about **115–165 ms** (median) on this machine.

**Decision: cost 10.**
- The planned rule was "the highest cost whose median is at most about 100 ms". **No cost meets that on this laptop**: even cost 10 is above 100 ms.
- 10 is also the agreed minimum, so the config refuses anything lower outside tests.
- Costs 11 and 12 would make each login roughly 2× and 4× slower. On a 4-thread machine at rush hour, that directly cuts how many logins per second the server can handle, which Phase 8 will measure.
- The choice should be re-checked on the demo/production machine with the same script.

### Seed timing (measured)
`docker compose exec app npm run seed` on the same machine, cost 10, `UV_THREADPOOL_SIZE=4`:
- First run: 1,502 accounts hashed in **79.5 s** (80.6 s total, 87 s wall clock). That is about 19 hashes per second with 4 pool threads. It was slower than my planned estimate of 30–60 s.
- Second run: nothing to do, **0.36 s**.
- The about 19 bcrypt hashes per second with 4 threads is an early hint of the login throughput ceiling. The real throughput numbers come from Phase 8 (`calibrate`).

### Tests (run 2026-10-11)
`npm test` runs both sets. Last two full runs: **unit 8 suites / 70 tests passed; integration 6 suites / 43 tests passed** (about 30 s).

**Unit tests** (`npm run test:unit`, stand-ins, no services needed):
- config: `BCRYPT_COST` floor of 10, low cost only in test, CSRF secret, seed counts configurable.
- password policy: every rule, the 72-byte limit, the blocklist.
- hasher: the dummy hash uses the same cost as real hashes.
- seed generator: deterministic, unique matric numbers.
- CSRF: missing or foreign token gives 403; cookie flags.
- input validation: runs before any database access and never echoes passwords.
- 503 on DB pool timeout, plus the Phase 0 tests.

**Integration tests** (`npm run test:integration`, real PostgreSQL and Redis from docker compose):
- They use a separate database, `<name>_test`, dropped and recreated each run, and Redis DB 15, so dev data is never touched.
- If PostgreSQL or Redis is down, they **fail with a clear message** (checked by stopping each container). They never skip.

| File | What it proves |
|---|---|
| `migrations.test.js` | All migrations run down completely and up again; roles and the policy row exist; CHECK and UNIQUE constraints reject bad rows |
| `seed.test.js` | Default seed gives 2,000 records, 1,500 student + 1 staff + 1 admin accounts, and 500 free; re-run creates nothing; hashes are bcrypt, not plain text; `npm run seed` respects the count variables; policy-violating seed passwords are refused |
| `register.test.js` | Registration stores normalized data and a bcrypt hash; login works afterwards by ID and by email; the three rejection cases give identical responses; weak/common passwords are refused with reasons; a live policy change applies without restart; two simultaneous sign-ups for one matric create exactly one account |
| `login.test.js` | Login by ID or email in any case; staff/admin roles; `last_login` set and counter reset; **five failure types give byte-identical 401s**; unknown-user timing is within 0.5–2× of wrong-password timing at cost 10 |
| `lockout.test.js` | 5 failures lock for 15 minutes; correct password refused while locked and the lock is not extended; expiry lets the user in and restarts the count; unlock through the service and through the CLI; **10 concurrent failures give exactly 5 and one lock**; live `max_attempts=3`; **FR-P5**: bcrypt failure gives 500, DB pool exhaustion gives 503, and invalid input gives 400, none of which count |
| `system.test.js` | `/health` 200 on real services; Redis DB 15 isolation; pages render the live rules; no CSRF token gives 403 and does not count; SQL-injection strings are treated as text; **no password or hash appears in the logs** |

### End-to-end check against the running containers (2026-10-11)
After `docker compose up --build -d` (the container applied 4 migrations) and `npm run seed`:
```
register SCI/2025/0061 (a free record)        -> 201 Account created
register SCI/2025/0061 again                   -> 400 generic "couldn't register" message
login                                          -> 200 {"message":"Signed in.","role":"student"}
5 wrong passwords                              -> 401 x5 (identical message)
correct password while locked                  -> 401 (same message)
POST without CSRF token                        -> 403
npm run admin -- locked                        -> SCI/2025/0061  failed=5  locked_until=2026-10-11T19:04:07Z
npm run admin -- unlock SCI/2025/0061          -> Unlocked
login by email after unlock                    -> 200
```
App container logs for this run contained **0** occurrences of the password and **0** bcrypt hashes. Events logged: register_success 1, register_rejected 1, login_success 2, login_failure (bad_password) 5, login_failure (locked) 1, lockout 1.

### Configuration added (`.env.example`)
`BCRYPT_COST` (default 10), `CSRF_SECRET` (required, at least 32 characters), `COOKIE_SECURE`, `SEED_REGISTERED_STUDENTS` (1500), `SEED_FREE_STUDENTS` (500), `SEED_STUDENT_PASSWORD`, `SEED_STAFF_PASSWORD`, `SEED_ADMIN_PASSWORD`.

### Decisions
- **New libraries:**
  - `bcrypt` 6.0.0: its prebuilt binary works in `node:24-slim`, so no compiler is needed.
  - `express-validator` 7.3.2.
  - `csrf-csrf` 4.0.3: the maintained replacement for the deprecated `csurf`.
  - `cookie-parser` 1.4.7.
  - `ejs` **6.0.1, not 7.0.1**: 7.0.1 was a week old.
- **Lockout state lives in PostgreSQL** (`users.failed_attempts`, `locked_until`), as SPEC §5 specifies. Redis is not used by any Phase 1 feature; the integration tests still check it through `/health`, and Redis-backed features start in Phases 4 and 5.
- **Seeded accounts use the real bcrypt cost.** Load tests and calibration log in as these accounts, so cost-4 hashes would make the measured login time (and the OMNeT++ input) wrong.
- **The pages need JavaScript** to submit forms, because the CSRF token goes in a header. A `<noscript>` message tells the user. Phase 5's backoff on 429/503 needs JavaScript anyway.
- **Policy row is read on every request** for now. **Phase 5 TODO:** cache it with invalidation on change (see "Open items").

### Commands
```bash
docker compose up --build -d                    # applies migrations automatically
docker compose exec app npm run seed            # about 80 s the first time at cost 10
docker compose exec app npm run admin -- locked
docker compose exec app npm run admin -- unlock <ID or email>
docker compose run --rm --no-deps app node scripts/bcrypt-bench.js 30
npm test                                        # unit + integration; needs: docker compose up -d postgres redis
```
Demo logins after seeding: any of the first 1,500 seeded matric numbers (for example `SCI/2025/0001`), `STAFF0001` or `ADMIN0001`, with the passwords from your `.env` (`SEED_*_PASSWORD`). Free records for the registration demo start at `SCI/2025/0061` (see `db/seed/lib/studentData.js`, records 1,501–2,000).

### Follow-up: test-output noise (2026-10-17)
The developer reported three things during `npm test`. Findings:
- **Six "Acquire connection error: operation timed out" lines:** all six come from **one deliberate FR-P5 test**, "a DB connection timeout (pool exhausted) returns 503…" in `lockout.test.js`. That test holds the only connection of a 1-connection pool and sends 6 logins with a 300 ms acquire timeout, so knex prints one warning per login.
  - Confirmed by running each test alone: that test prints 6 warnings; the 10-concurrent-logins test and every normal-login test print 0.
  - **Fix:** the test now captures knex's warnings itself (knex's `log.warn` option) instead of letting them reach the console. It also **asserts that the injected failure happened**: exactly 6 acquire-timeout warnings and 6 logged `KnexTimeoutError`s.
  - The bcrypt-failure test now likewise asserts that its injected `compare` failure ran 6 times and was logged 6 times.
- **MaxListenersExceededWarning (11 listeners on a Server):** from the 10-concurrent-logins test.
  - When supertest is given a bare Express app, it starts its own server, and every request sent while that server is still starting adds a one-time `listening` and `error` listener. Ten concurrent requests plus supertest's own listener made 11. It was not a leak in the app.
  - **Fix:** integration tests now start a real listening server (`listen()` in `tests/integration/helpers.js`), and a global `afterEach` closes every server a test opened.
- **Lockout suite duration (19.6 s vs 43.8 s):** not reproduced.
  - In 4 runs the suite took **12.4, 15.6, 13.3 and 13.0 s**; the full `npm test` took 60–68 s wall clock.
  - Two tests account for most of the time:
    - the admin-CLI test, 6.2–7.7 s, because it starts 5 separate Node processes;
    - the pool-exhaustion test, 2.0–2.5 s by design (6 × 300 ms timeouts).
  - The concurrency test took 0.7–1.2 s. These tests use bcrypt cost 4, so thread-pool contention is not a factor.
  - The 43.8 s run was most likely machine load (Windows process start-up for the CLI test, or the Docker VM competing for 4 CPUs). Nothing was changed for timing.
- **Result:** two full `npm test` runs after the fix both passed (unit 70, integration 43), with **0** acquire-timeout lines, **0** MaxListeners warnings, and **0** console output blocks.

### What to screenshot
- `/register` on a phone-width browser, showing the password rules and the privacy notice.
- A rejected registration (generic message) and a weak-password error.
- `/login` showing the generic error after a wrong password.
- Terminal: `npm run admin -- locked` showing a locked account, then `unlock`.
- `npm test` summary (unit 70, integration 43).
- The bcrypt timing table above (`npm run bench:bcrypt` output).
- psql: `SELECT matric_or_staff_id, left(password_hash, 7), failed_attempts, locked_until FROM users LIMIT 5;` showing `$2b$10$` hashes and no plain passwords.

---

## Phase 2: Second factors and recovery (2026-10-17)

Built in five sub-steps, one commit each, with the full `npm test` run after each:

| Sub-step | Commit | What |
|---|---|---|
| 2.1 | `c807099` | Migration, key config and startup validation |
| 2.2 | `1bae982` | Pre-auth ticket, email OTP, delivery drivers, Mailpit |
| 2.3 | `8e178e9` | TOTP enrolment and backup codes |
| 2.4 | `2114853` | Password reset, change, notification email |
| 2.5 | `68503bb` | Admin 2FA enforcement, `reset-2fa` CLI, knex logs to pino |

### Requirements covered
| ID | Status | Notes |
|---|---|---|
| FR-A7 | Done | Email OTP: 6 digits from a CSPRNG, stored as an HMAC (server key), 5 min expiry, max 3 attempts, single use, resend with 60 s cooldown. |
| FR-A8 | Done | TOTP enrolment with QR code; secret encrypted at rest; ±1 step drift; replay blocked; 8 hashed single-use backup codes shown once. |
| FR-A9 | Done | Reset by emailed token: 32 random bytes, HMAC-stored, 30 min (configurable), single use, older tokens invalidated, identical response for unknown emails. |
| FR-A10 | **PARTIAL** | Change password works (same policy, wrong current password counts as a failure, notification email). **"Logs out other sessions" waits for Phase 4** (no sessions yet); today the user's pre-auth and account tickets are revoked instead. |
| FR-A13 | **PARTIAL** | Enforced at sign-in (an admin without TOTP can only enrol TOTP) and by the `requireAdmin2FA` middleware, both tested. **The admin console itself does not exist until Phase 6**, so no real `/admin` route uses the middleware yet. `policies.require_2fa_admin` is pinned to `true` by a CHECK constraint and is not a setting. |
| FR-A14 | Done | Delivery interface with `console`, `email`, `sms-mock` drivers, each with a timeout. |
| FR-A6 | Still PARTIAL | Unchanged from Phase 1 (audit log Phase 3, console Phase 6). Second-factor failures now also count toward lockout. |
| FR-P5 | Extended | Delivery failures, delivery timeouts, Redis/DB outages, expired or exhausted codes, and a changed `TOTP_ENC_KEY` never count toward lockout (all tested). |

### How sign-in works now
1. `POST /auth/login` checks the password exactly as in Phase 1. Then:
   - **No 2FA:** `{status: "signed_in"}` plus the account ticket (below).
   - **2FA on:** `{status: "second_factor_required", method: "email" | "totp"}` plus a **pre-auth ticket** cookie. For email, a code is sent at once. **For a 2FA account, a correct password does not reset the failure counter**; only a completed second factor does. Otherwise someone who knows the password could keep resetting the counter and guess codes without limit.
   - **Admin without TOTP:** `{status: "enrolment_required"}` plus an **enrolment-only** account ticket (FR-A13).
2. `POST /auth/otp {code}` (email) or `POST /auth/totp/verify {code}` / `{backupCode}` (TOTP users) completes sign-in. TOTP users can fall back to backup codes only, never to email.

**Pre-auth ticket:**
- What it is: 256 random bits in an HttpOnly, SameSite=Strict cookie. Redis stores only an HMAC of it, so a copy of Redis contains no usable ticket.
- Lifetime: 5 minutes, with its own limit of 5 attempts (`PREAUTH_MAX_ATTEMPTS`).
- It's single use: a success consumes it in one atomic Redis (Lua) step.

**How second-factor failures count:**

| Event | Counts toward lockout? |
|---|---|
| Wrong email OTP, wrong TOTP code, wrong backup code, reused TOTP code (replay) | **Yes**, same counter as wrong passwords; 5 in total lock the account |
| Expired, used-up (3 attempts) or missing OTP | No (often the system's fault, e.g. a slow email) |
| Delivery failure or timeout, Redis or DB outage, decryption failure | No (FR-P5) |
| Invalid input (400), missing CSRF (403), expired ticket (401 "start again") | No |

**Interim account ticket** (approved for Phase 2 only; **TODO Phase 4: delete it** and use the JWT session):
- 10 minutes, HttpOnly, SameSite=Strict, CSRF required.
- Accepted **only** by: `GET /account/security`, `POST /auth/2fa/email/enable`, `POST /auth/2fa/email/confirm`, `POST /auth/totp/enrol`, `POST /auth/totp/enrol/confirm` and `POST /auth/password/change`.
- A unit test walks Express's whole route tree and fails if any other route accepts it. Integration tests show it's refused by the sign-in endpoints, and that a pre-auth ticket is refused by the settings endpoints.
- The enrolment-only variant is accepted only by the page and the two TOTP enrolment routes.

### Email OTP (FR-A7, FR-A14)
- The code comes from `crypto.randomInt` and is stored as `HMAC-SHA256(TOKEN_HMAC_KEY, "otp:" + userId + ":" + code)`, compared in constant time.
- Each attempt is counted **before** comparing, in one atomic `UPDATE … WHERE attempts_used < 3`. In the test, 10 simultaneous wrong codes gave exactly 3 comparisons and 3 counted failures.
- A new code cancels older open codes. Resend has a 60 s per-account cooldown in Redis (429 with `Retry-After`).
- If delivery fails, the code is cancelled and the cooldown lifted, so the user can retry immediately. The failure is logged with any email address scrubbed.

**Delivery drivers** (`OTP_DELIVERY_DRIVER`):

| Driver | Use | Production |
|---|---|---|
| `email` (default) | nodemailer to SMTP; Mailpit in development | Allowed |
| `console` | Writes the message, including the code, to stdout directly, never through the logger. Logs a startup warning. | **Refused at startup** |
| `sms-mock` | Stores the message in a capped Redis list keyed by matric number (no phone numbers are stored: NFR-5) | **Refused at startup** (my addition: it keeps codes in plain text in Redis) |

### TOTP and backup codes (FR-A8)
**Enrolment** (`POST /auth/totp/enrol`, then `/confirm`):
- A 20-byte base32 secret is created. While pending, it's kept encrypted in Redis for 10 minutes.
- The QR code is a PNG data URL, and the key is shown for manual entry once.
- One valid code confirms enrolment. The secret is then stored with **AES-256-GCM using `TOTP_ENC_KEY`, with the user id as associated data**, so an encrypted secret copied onto another account fails to decrypt.

**Verification** (otplib 13.5.0, API confirmed from the installed type definitions and by running it):
- `epochTolerance: 30` accepts one 30 s step either side.
- Replay is blocked twice over:
  - `afterTimeStep` rejects a code from a step that was already used;
  - an atomic `UPDATE users SET totp_last_step = ? WHERE totp_last_step < ?` means two requests with the same code can't both succeed (tested).
- A code that isn't 6 digits makes otplib throw, so input is validated first and gets a 400, not a 500.

**Backup codes:**
- 8 codes of 10 characters from an alphabet without look-alike characters (no 0/O/1/I/L/U), about 49 bits each, shown as `XXXXX-XXXXX`.
- Stored as HMACs, not bcrypt hashes: with 49 bits of randomness a slow hash isn't needed, and checking 8 bcrypt hashes would add about 1 s per attempt at rush hour.
- Single use (atomic); case, dash and spaces in the input are ignored.

**Switching method:** a student with email 2FA may switch to TOTP. Enrolment is refused only when TOTP is already on.

### Password reset and change (FR-A9, FR-A10)
**Forgot password:**
- `POST /auth/password/forgot` **always answers with the same 202 body**. Lookup, token creation and sending happen **after** the response, so response time doesn't depend on whether the email exists or how slow the mail server is.
  - In the test, a driver that takes 800 ms to send still gave responses well under 400 ms, with a known/unknown ratio between 0.33 and 3.
- There's a 60 s cooldown per email, applied to unknown emails too.
- Background failures are **logged without email addresses and counted** in Redis (`cg:metrics:reset_email_failures`; successes in `cg:metrics:reset_emails_sent`). They are never swallowed.

**The reset link** is `APP_BASE_URL/reset-password#token=…`. The token is in the URL **fragment**, which browsers never send to the server, so it can't appear in request logs or `Referer` headers. The page's script copies it into the form and removes it from the address bar.

**Reset:**
- Same password policy. An invalid token is rejected before any bcrypt work.
- The token is consumed atomically: of two concurrent resets with one token, exactly one wins. Older unused tokens are invalidated.
- **A successful reset clears the lockout** (the old password it protected no longer exists) and **never touches 2FA**: the next sign-in still asks for the second factor (tested).

**Change** (account ticket): a wrong current password counts as a credential failure; same policy.

**After a reset or change:**
- The user's pre-auth and account tickets are **revoked** (addition B). **TODO Phase 4: also revoke sessions.**
- A **"your password was changed"** email goes through the same driver without blocking the request; failures are logged and counted (`cg:metrics:notification_email_failures`) (addition C).

**Attempt limits for reset tokens:** each token is 256 random bits, so guessing is not feasible and there's no per-token attempt counter. Per-IP limits on `/auth/password/reset` come with the Phase 5 rate limiter.

### Admin 2FA, recovery CLI and logging
**FR-A13:**
- An admin without TOTP who enters the correct password gets `enrolment_required`. They can't do anything except enrol TOTP: change password and email 2FA are refused.
- After enrolling, the enrolment ticket is revoked and the admin must sign in again with a TOTP code.
- Admins can never use email codes, even if email 2FA is forced on in the database.
- `requireAdmin2FA` is ready for the admin console.

**Lost-device recovery** (addition A): `npm run admin -- reset-2fa <ID or email> --confirm`.
- It clears the TOTP secret, backup codes, open OTP codes and the 2FA flag, and revokes the user's tickets in Redis.
- Without `--confirm` it refuses (exit code 2) and changes nothing.
- An admin reset this way must re-enrol at the next sign-in. **TODO Phase 3: audit-log it.**

**knex logs into pino** (answer 9):
- knex warnings, errors and deprecations go to the app logger (`event: "knex_warning"`, …) instead of `console.log`.
- knex's query debug output (which includes bindings) stays off.
- PostgreSQL error fields that contain values (`detail`, e.g. "Key (token_hash)=(…) already exists", plus `where`, `parameters`, `bindings`) are removed by the logger's error serializer.
- **Found while testing:** pino-http replaces the error serializer on per-request loggers. Without passing ours to pino-http explicitly, `detail` leaked through `req.log` (checked directly). Ours is now set on both.

**Other logging:**
- Errors that can quote an email address (SMTP errors) are logged scrubbed, under `error`.
- Background emails are tracked, and graceful shutdown waits for them before closing the database.

### Things the report should state (addition E)
1. **If `TOTP_ENC_KEY` is lost or changed, every stored TOTP secret becomes unreadable.** Those users get a 500 at the TOTP step, which doesn't count toward lockout, and must be reset with `npm run admin -- reset-2fa <ID> --confirm`, then re-enrol. Back up the key with the database backups, but never in the same place as them.
2. **2FA sign-in depends on Redis**, where the pre-auth tickets live. If Redis is down, a 2FA sign-in returns **503**, and nothing is counted (tested). A password-only sign-in still works without Redis; only the security-settings page is unavailable.
3. **Email delivery in the request path is a peak-load concern.** The sign-in code is sent inside `POST /auth/login`, so a slow SMTP server makes logins slow. To revisit in Phases 5 and 8. **The `calibrate` output must include the OTP step time** (send + verify).

### Versions checked (addition F)
Commands run on 2026-10-17 (cutoff for "older than 14 days": 2026-10-03):

```
$ npm view otplib time --json        -> 13.5.0  2026-08-21   (used)
$ npm view qrcode time --json        -> 1.5.4   2024-08-05   (used)
$ npm view nodemailer time --json    -> 10.0.13 2026-09-30   (used)
                                        10.0.14 2026-10-03 13:45, 10.0.15 ... 10.1.2 2026-10-16: under 14 days, NOT used
$ curl https://hub.docker.com/v2/repositories/axllent/mailpit/tags/v1.31.3
                                     -> tag_last_pushed 2026-09-27 (used); v1.31.4 (2026-10-03) and later: under 14 days
```
- All three npm packages are pinned to **exact** versions. Every newly added transitive package was also checked with `npm view <pkg> time[<version>]`; the newest is `@scure/base` 2.4.0 (2026-08-28).
- The lock file was regenerated inside `node:24-slim`. It added 22 packages and changed no existing ones.
- **otplib v13 API** was confirmed from `node_modules/@otplib/totp/dist/index.d.cts`: `verify({ secret, token, epochTolerance, afterTimeStep })` returns `{ valid, delta, epoch, timeStep }`. I then ran it: ±1 step accepted, 3 steps rejected, replay rejected via `afterTimeStep`, and a 5-digit token throws `TokenLengthError`.
- **Mailpit** settings come from its runtime-options docs (`MP_MAX_MESSAGES`, `MP_SMTP_AUTH_ACCEPT_ANY`, `MP_SMTP_AUTH_ALLOW_INSECURE`). The healthcheck comes from the image itself: the v1.31.3 image ships `HEALTHCHECK ["CMD","/mailpit","readyz"]`, and `mailpit readyz --help` documents it. API paths come from the v1.31.3 swagger file: `/api/v1/search`, `/api/v1/message/{ID}`, `/api/v1/messages`.

**Jest note:** otplib's CommonJS build requires `@scure/base`, which is ESM-only. Plain Node 24 loads that natively (checked in `node:24-slim`, no flags). Jest's module loader needs `--experimental-vm-modules`, so `npm run test:unit` and `test:integration` run Jest through `node --experimental-vm-modules --disable-warning=ExperimentalWarning`. This affects tests only.

### Schema changes (migration `20261017120000_second_factors_and_recovery`)
- `users` gains `two_factor_method` (`email`/`totp`) and `totp_last_step` (for replay blocking), both beyond SPEC §5. CHECKs enforce:
  - 2FA flag ⇔ method set;
  - TOTP ⇒ secret present.
- `policies`: CHECK `require_2fa_admin = true`.
- New tables:
  - `otp_codes`: attempts capped at 3 by CHECK; `channel` must be a known driver; `created_at` added.
  - `totp_backup_codes`: UNIQUE (user, hash).
  - `password_reset_tokens`: unique `token_hash`; `created_at` added.

### New `.env` variables
| Variable | Default | Notes |
|---|---|---|
| `TOKEN_HMAC_KEY` | none (**required**) | ≥32 bytes, base64/base64url. HMAC key for OTPs, backup codes, reset tokens, ticket ids. |
| `TOTP_ENC_KEY` | none (**required**) | **Exactly 32 bytes.** AES-256-GCM key for TOTP secrets. Losing it makes them unreadable. |
| `OTP_DELIVERY_DRIVER` | `email` | `email` / `console` / `sms-mock` (the last two refused in production) |
| `DELIVERY_TIMEOUT_MS` | 10000 | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | localhost, 1025, false | compose sets `SMTP_HOST=mailpit` for the app container |
| `MAIL_FROM` | `CampusGate <no-reply@campusgate.test>` | |
| `APP_BASE_URL` | `http://localhost:3000` | used in reset links |
| `PREAUTH_TTL_SEC`, `PREAUTH_MAX_ATTEMPTS` | 300, 5 | |
| `OTP_RESEND_COOLDOWN_SEC`, `RESET_COOLDOWN_SEC` | 60, 60 | |
| `RESET_TOKEN_TTL_MIN` | 30 | |
| `ACCOUNT_TICKET_TTL_MIN` | 10 | interim, removed in Phase 4 |

At startup, the app checks that the three secrets (`CSRF_SECRET`, `TOKEN_HMAC_KEY`, `TOTP_ENC_KEY`) are all different. On the developer machine, the two new keys were generated and appended to `.env` (values not printed); everything else uses the defaults.

### Tests (run 2026-10-17)
Final `npm test`: **unit 12 suites / 109 tests passed; integration 13 suites / 122 tests passed**, with no console output. The integration suite now also needs Mailpit (`docker compose up -d postgres redis mailpit`) and fails with a clear message if it isn't running.

| New integration file | What it proves |
|---|---|
| `tickets.test.js` | Ticket is 256 bits, only its HMAC is in Redis, TTL set; single use; 10 concurrent consumes give 1 winner; attempt limit; 10 concurrent attempts with limit 5 give exactly 5; per-user revocation; malformed values rejected |
| `emailOtp.test.js` | Correct password gives pre-auth ticket and code (counter not reset); code stored as HMAC, 5 min TTL; correct code signs in, single use; expired code refused and not counted; 3 attempts per code; **10 concurrent wrong codes give exactly 3 checks / 3 failures**; ticket attempt limit; second-factor failures lock the account; resend cancels the old code; cooldown gives 429 + Retry-After; **delivery failure is not counted, gives 503 on resend, and its log has no email address**; **Redis down gives 503 for 2FA** (password-only still signs in); sms-mock writes to Redis; **no OTP or ticket in logs** |
| `totp.test.js` | QR + secret; pending secret encrypted; stored secret encrypted and bound to the user; 8 hashed backup codes; wrong confirm code refused; double enrolment refused; sign-in with TOTP; **drift ±1 accepted, −2 steps refused**; **replay refused and counted**; **replay race gives exactly one success**; backup codes single use and relaxed format; concurrent backup-code use gives 1 success; no email fallback for TOTP users; **changed `TOTP_ENC_KEY` gives 500, not counted**; malformed codes give 400; **no secret, otpauth URI, code or backup code in logs** |
| `passwordReset.test.js` | **Byte-identical 202** for known, unknown and different-case email; **timing independent of email and mail server**; token is 32 bytes, in the fragment, HMAC-stored, 30 min; single use; expiry; newer request invalidates older tokens; policy enforced without burning the token; concurrent resets give 1 winner; **reset clears lockout**; **reset doesn't bypass 2FA**; tickets revoked; notification email doesn't block; background failures logged without the email and counted; cooldown; change password (revokes tickets, wrong current password counted, policy, needs ticket); **no token, password or email in logs** |
| `accountTicket.test.js` | Ticket cookie flags and 10 min TTL; settings page needs it; enable email 2FA end to end; ticket refused by sign-in endpoints; pre-auth ticket refused by settings; expired ticket refused; CSRF still required |
| `admin2fa.test.js` | Admin without TOTP gets `enrolment_required` (counter not reset); enrolment-only ticket opens only TOTP enrolment; admin with forced email 2FA still sent to TOTP enrolment; after enrolment, TOTP is needed to sign in; signed-in admin can't choose email; `requireAdmin2FA`: admin+TOTP passes, student refused, admin whose TOTP was removed refused, enrolment ticket refused; `reset-2fa` refuses without `--confirm`, clears everything, revokes tickets, admin must re-enrol, student back to password-only, unknown user gives exit 1; **knex warning goes to pino, not console** |
| `mailpit.test.js` | Real SMTP: sign-in code email, and reset link email, single use, plus the "password changed" email |

New unit tests cover:
- config key validation (lengths, base64, all secrets different, console/sms-mock refused in production);
- the crypto helpers (HMAC domain separation, AES-GCM bound to the user id, tamper detection);
- the delivery timeout wrapper;
- backup-code format;
- 503 for Redis outages and `Retry-After`;
- the route-tree scan for the account ticket;
- pg `detail`/bindings dropped on both logger paths.

**Problems found and fixed while building** (all in tests or test plumbing unless stated):
- A capture driver threw a look-alike `DeliveryError` instead of the real class.
- **App bug:** pino's `err` serializer reshaped scrubbed error objects. Fixed by logging them under `error`.
- **App bug:** going over the ticket attempt limit returned the attempt count instead of −1, so the over-limit attempt would still have been checked. Found by review before the tests ran.
- A test deadlocked: one test's background reset email was still writing while the next test's TRUNCATE ran. Fixed by tracking background work and waiting for it after every test, and in graceful shutdown.
- **App bug:** pino-http hands custom serializers an already-serialized error, so ours re-wrapped it and the error type became "Object". Fixed and covered by a unit test.

### End-to-end check against the running containers (2026-10-17)
- After `docker compose up --build -d`, the app container applied the new migration ("Batch 2 run: 1 migrations"), started with `otpDeliveryDriver: "email"`, and `/health` returned 200.
- A script (not in the repo) drove the real stack with real Mailpit emails and real TOTP codes, using the seeded `ADMIN0001` and the demo student `SCI/2025/0061`.
- **Results:** all 26 checks in the final run passed: admin forced enrolment and its restrictions; QR and 8 backup codes; TOTP sign-in; replay refused; backup code works once; student email 2FA enable and sign-in via Mailpit; identical forgot responses; reset link in the fragment, single use; "password changed" email; 2FA still required after reset; change password and ticket revoked; lockout and CLI unlock; `reset-2fa` refusing without `--confirm`, then resetting both accounts.

**What failed on the way:**
- **First run:** step 21 failed because of the **script**, not the app. The second sign-in came within the 60 s resend cooldown, so correctly no new code was sent (`codeSent: false`). The script then picked up the earlier, already-used code by timestamp, and the Docker VM clock is about 5 s ahead of the host.
  - I fixed the script to track emails by Mailpit message ID and to wait out the cooldown and press Resend, as a user would.
  - That failed run had left the demo student's password changed; I restored it.
- **Both runs:** the last two checks ("admin back to `enrolment_required`", "student back to password-only") aborted with a client-side `fetch failed` right after several `docker compose exec` CLI calls. The app logged no such requests and never restarted. Run separately straight afterwards, **both passed**. I couldn't explain or reproduce this (a 6.5 s idle keep-alive test worked). It looks like a Docker Desktop port-forwarding hiccup on this machine, not an app fault.

**Driver behaviour in the container:**
- `NODE_ENV=production OTP_DELIVERY_DRIVER=console` gives "Invalid configuration: OTP_DELIVERY_DRIVER=console … is refused when NODE_ENV=production" and exit code 1.
- In development it logs the warning "OTP_DELIVERY_DRIVER=console: one-time codes and links are printed to stdout. Development/test only."

**Final state:** `ADMIN0001` is back to "must enrol TOTP", and `SCI/2025/0061` is password-only with its original password (`Kettle-Mango-42`). Both are ready for the manual checks below.

**Note for whoever runs tests:** `mailpit.test.js` **empties the Mailpit inbox** (`DELETE /api/v1/messages`), and the integration tests send real emails to it. Don't keep anything you need in the development Mailpit while running `npm test`.

### What to try by hand
Mailpit (every email the app sends): **http://localhost:8025**. App: **http://localhost:3000**.
1. **Admin TOTP enrolment:**
   - Sign in as `ADMIN0001` with `SEED_ADMIN_PASSWORD` from `.env`. You land on Security settings with "must set up an authenticator app".
   - Press **Set up authenticator app** and scan the QR code with Google Authenticator, Microsoft Authenticator or Aegis (or type the key).
   - Enter the 6-digit code and press **Turn on authenticator app**. **Write down the 8 backup codes.**
   - Sign in again: you're asked for the authenticator code.
2. **Backup codes:** sign in as `ADMIN0001`. On the verify page, enter one backup code in the backup-code box: it works. Go back to `/login`, sign in again (there's no sign-out button until Phase 4), and try the same backup code: it's refused.
3. **Email OTP (student):**
   - Sign in as `SCI/2025/0061` / `Kettle-Mango-42`. On Security settings, press **Send me a code**, open Mailpit, enter the code, and press **Turn on email codes**.
   - Sign in again: a code arrives in Mailpit. Enter it.
   - Try a wrong code 3 times, then the right one: refused (3-attempt limit). Press **Resend** within 60 s: "Please wait …".
4. **Password reset:**
   - On `/login`, press **Forgot password?** and enter `demo.student@example.com`. Then try `nobody@example.com`: the message is identical.
   - Open the reset email in Mailpit and click the link. Notice the address bar loses the `#token=…` part.
   - Set a new password, then click the same link again: "invalid or has expired". A "password changed" email also arrives.
   - If 2FA is on, the next sign-in still asks for the code.
5. **Lockout:** enter a wrong password 5 times for `SCI/2025/0061`. The correct password is then also refused.
   - `docker compose exec app npm run admin -- locked` lists the account.
   - Then **either** `npm run admin -- unlock SCI/2025/0061`, **or** reset the password by email, which also clears the lock.
6. **Lost device:** `docker compose exec app npm run admin -- reset-2fa ADMIN0001` refuses. Add `--confirm` and it resets. The admin must enrol again at the next sign-in.

### Evidence to capture for the report
- Mailpit inbox showing a sign-in code email, a reset email (link with `#token=`) and a "password changed" email.
- The Security settings page with the QR code; the 8 backup codes screen (blur them).
- An authenticator app showing the CampusGate entry.
- `/verify` with "Invalid or expired code."; and a 429 "Please wait …" on resend.
- The two identical forgot-password messages (known and unknown email).
- psql:
  - `SELECT matric_or_staff_id, two_factor_method, left(totp_secret_enc, 12) FROM users WHERE two_factor_enabled;` shows `v1:…` ciphertext, not a base32 secret;
  - `SELECT code_hash, attempts_used, used FROM otp_codes ORDER BY id DESC LIMIT 3;`
  - `SELECT left(token_hash, 10), used, expires_at - created_at FROM password_reset_tokens ORDER BY id DESC LIMIT 3;` shows a 30-minute lifetime.
- `docker compose exec redis redis-cli --scan --pattern 'cg:*'` showing hashed ticket keys, not raw tokens.
- `npm test` summary (unit 109, integration 123 after the follow-up below).
- `docker compose exec app npm run admin -- reset-2fa ADMIN0001` (refusal) and with `--confirm`.

### Follow-up: test hardening (2026-10-20)
**Reported:** under heavy load, the integration test "knex warnings (pool acquire timeout) go to pino" once failed with `KnexTimeoutError`, and Jest then hung for over 5 minutes.

**Cause (reproduced):**
- The test held the pool's only connection with `await tiny.transaction()` **before** its `try/finally`, under a deliberately short 200 ms acquire timeout.
- Taking that connection means opening a new PostgreSQL connection. On a busy machine that took longer than 200 ms, so `transaction()` itself threw.
- The `finally` never ran, so the pool was never destroyed (and the `console.log` spy never restored), and its connection kept Jest alive.
- Reproduced with a 1 ms timeout: the same `KnexTimeoutError`, and Jest did not exit (killed after 150 s).
- The lockout suite's pool-exhaustion test had the same weakness (300 ms).

**Changes:**
- **Both pool tests:** a new helper, `holdOnlyConnection()`, retries `transaction()` until the connection is held. A timed-out acquire doesn't cancel the connection being opened, so the next attempt gets it. Warnings from that warm-up are discarded before asserting.
  - Everything, including taking the connection, now runs inside `try/finally`, which always rolls back, destroys the pool and restores the spy.
  - Checked with a 1 ms timeout (every attempt loses the race): 48 timed-out warm-up attempts, then the test passed and Jest exited.
- **Teardown safety net:** every DB pool, Redis client and SMTP transport opened by integration tests is registered and closed after each test file (`afterAll` in `tests/integration/setup.js`), even if a test fails half-way.
- **`--detectOpenHandles`:** both suites report no open handles when passing. The hang only happened on the failure path above, which is now closed.
- **Other timing-dependent tests made deterministic:**

| Test | Before | Now |
|---|---|---|
| Unknown-user vs wrong-password login | compared wall-clock medians (ratio 0.5–2) | records every bcrypt compare: all five failure paths (wrong password, unknown matric, unknown email, inactive, locked) do exactly one compare at cost 10, i.e. equal work |
| Forgot-password timing | medians < 400 ms with an 800 ms mail driver | a **gated** driver that can't finish sending until the test releases it; both responses (known and unknown email) arrive while the gate is closed, which proves the mail server isn't in the request path |
| "Password changed" email doesn't block | response < 1.2 s | gated driver: the reset answers while the notification is still blocked |
| Waits for background emails | polling with 5–10 s deadlines | wait on the app's own background-work tracker (`idle()`) |
| TOTP drift / replay tests | codes made from the real clock; a 30 s step boundary between generating and checking could reject a valid "one step behind" code | the TOTP service takes an injectable clock (default: real time); tests pin it 15 s into a step |
| Health / delivery timeout unit tests | elapsed time < 2 s / < 1 s | bound removed: if the timeout didn't fire, the request would hang and Jest's per-test timeout would fail it anyway |

- Fixed sleeps that remain (1.1 s against a 1 s Redis cooldown) are lower bounds, so a busy machine can only make them longer, never cause a false failure.

**Note for the report (FR-A5 timing):** the automated login-failure test checks **"same work done"**, not elapsed time. Every failure path (wrong password, unknown matric, unknown email, inactive account, locked account) performs exactly one bcrypt check at cost 10, so there is no timing difference to observe. **Real response timing of these paths will be measured manually in Phase 9** (security tests), on a quiet machine, and reported there.

**Which test fails if database error details reach the logs:**
- **Integration:** `tests/integration/system.test.js` › "database error details (pg `detail` with a token hash) never reach the logs of the real app". It takes a **genuine** PostgreSQL unique-violation error whose `detail` contains a token-hash value and pushes it through the real app's request logger and error handler. Then it asserts the error code is logged but the value is not.
  - Mutation check: removing the serializer from the app's pino-http setup makes this test fail on exactly that value.
- **Unit:** `tests/unit/logger.test.js` › "drops database values from errors (pg detail, bindings), on the app logger and on request loggers".

**Results: three full `npm test` runs in a row (2026-10-20)**

| Run | Machine | Unit | Integration | Wall time | Console noise / open handles |
|---|---|---|---|---|---|
| 1 | idle | 109 passed | 123 passed | 244 s | none; exited by itself |
| 2 | idle | 109 passed | 123 passed | 178 s | none; exited by itself |
| 3 | **CPU stress**: 5 busy threads on 4 logical CPUs, CPU at 100% before and at the end | 109 passed | 123 passed | 852 s (integration 725 s) | none; exited by itself |

---

## Phase 3: Authorization and audit logs (2026-10-22 to 2026-10-24)

| Sub-step | Where | What |
|---|---|---|
| 3.1 | `0205a4d` on `main` | `services`, `role_permissions`, in-memory permission map, `requirePermission` middleware |
| 3.2 | `733c934` (code, checkpointed by the developer) + `a2b3798` (tests and fixes), on `main` | `auth_logs` with keyed hash chain, whitelisted events, sync mode, every Phase 1/2 event wired, fail open / fail closed |
| 3.3 | branch `audit-queue-experimental` only | Queue mode (Redis Stream + single writer service): **designed and prototyped, not enabled; future work** |
| 3.4 | `main` (commit "Phase 3.4") | `npm run audit -- verify / search / export`, CSV formula-injection protection, `policy_history`, admin CLI `policy` / `role` / `perm` / `history` |

### Requirements covered
| ID | Status | Notes |
|---|---|---|
| FR-Z1 | **PARTIAL** | `services` + `role_permissions` tables, approved seed mapping, `requirePermission(service)` middleware answering from an in-memory map (no DB read per check) that every app process reloads on a Redis pub/sub notice. **No protected service route exists until the Phase 4 portal pages**; admin routes come with the console (Phase 6). |
| FR-Z5 | Done for every change path that exists | Policy, role and permission changes (CLI) are logged with who, when, old and new values in `policy_history`, plus an audit event, in one transaction. The admin console editing screens come in Phase 6. |
| FR-L1 | Done (Phase 1-3 events) | Every event below, with IP and user agent. Sign-out and session events arrive with sessions (Phase 4). |
| FR-L2 | Not started | Session records come with sessions (Phase 4). |
| FR-L3 | **PARTIAL** | Keyed hash chain, append-only triggers, outside anchor, `npm run audit -- verify`. The admin "Verify integrity" **button** is Phase 6. |
| FR-L4 | **PARTIAL** | Search/filter and CSV export through the CLI. The admin logs **screen** is Phase 6. |

### Default permissions (approved)
| Role | Services |
|---|---|
| student | fees, hostel, course_registration |
| staff | fees, hostel, course_registration ("staff-specific services" = future work) |
| admin | admin_console only |
| guest | none (vouchers, Phase 7) |

### Audit log design (sync mode)
- **Table `auth_logs`:** `seq` (gap-free chain position), `event_id` (unique; makes re-writing an event a no-op), `occurred_at`, `event_type`, `user_id` (no foreign key, so records outlive accounts), `subject_hash`, `ip` (full, as approved), `user_agent` (≤ 256 chars), `success`, `details` (JSON), `prev_hash`, `row_hash`.
- **Chain:** `row_hash = HMAC-SHA256(AUDIT_HMAC_KEY, prev_hash + canonical row)`. The key lives only in `.env`, never in the database, so someone with database access alone cannot recompute the chain after an edit. **If `AUDIT_HMAC_KEY` is lost or changed, existing chains can no longer be verified** (verify reports `row_hash` at seq 1).
- **Serialization:** every write takes one PostgreSQL advisory lock, so concurrent writers can never fork the chain (tested with 50 concurrent logins).
- **Append-only:** database triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `auth_logs`. **The table owner can still switch the triggers off** (`ALTER TABLE ... DISABLE TRIGGER`), and today the app connects as the owner; a limited app database role is a **Phase 9** item. Any change made that way is still caught by `verify`.
- **Outside anchor:** after each write the latest `{seq, hash}` is stored in Redis (`cg:audit:head`), because deleting the newest rows cannot be seen from the chain alone. See the open item about this anchor's limit.
- **What an event may contain:** each event type has a whitelist of detail fields; values must be short plain strings, integers or booleans. Passwords, codes, tokens, secrets, backup codes and email addresses cannot be recorded (the builder rejects them, and a test scans every stored row). A failed login with an unknown identifier stores a keyed hash of what was typed (`subject_hash`), so repeated attempts on one account can be correlated without storing the text.

**Events recorded:** `register`, `login_success` (method: password / email / totp / backup), `login_failure` (reason, stage), `lockout`, `second_factor_required`, `admin_enrolment_required`, `otp_sent`, `otp_delivery_failed`, `otp_verified`, `otp_failed`, `backup_code_used`, `totp_enrolment_started`, `two_factor_enabled`, `reset_requested`, `reset_email_failed`, `password_reset`, `password_changed`, `password_change_failed`, `admin_unlock`, `admin_reset_2fa`, `policy_changed`, `role_changed`, `permission_changed`, `audit_verified`, `audit_exported`.

**What happens when an audit write fails (approved policy):**

| Events | Policy | What the user sees |
|---|---|---|
| Logins, OTP, registration, reset requests (high volume) | **Fail open** | The action goes ahead. The event is written to the app log as a marked line (`AUDIT_FALLBACK`, with the full event) and counted in Redis (`cg:metrics:audit_fallback`). |
| Password reset, password change, 2FA enable, admin unlock / 2FA reset, policy / role / permission changes, audit verify / export | **Fail closed** | The audit row is written in the **same transaction** as the change. If it cannot be written, the change rolls back and the user gets **503** "This change can't be recorded in the audit log right now, so it was not made." (CLI: exit code 1). |

Tested with a genuine PostgreSQL failure (a temporary `CHECK (false)` constraint on `auth_logs`): a login still succeeds with a fallback line; a password change, password reset (token not used up), TOTP enable, CLI unlock and policy change are all refused and nothing changes.

**Fallback import (`import-fallback`): not built** (developer decision, P2). Fallback lines carry the complete event including its `event_id`, so a later importer could append them to the chain idempotently.

**Cost on the login path:** in sync mode every login waits for its audit insert under the chain lock. That cost has **not been measured yet**; it belongs to Phase 8 (`calibrate`).

### Queue mode: designed and prototyped, not enabled (future work)
Branch `audit-queue-experimental` (pushed) holds:
- a Redis Stream with a maximum length, where a full queue drops the event with a counter and **never blocks a login**;
- a single writer that acknowledges entries **only after the database commit**, re-reads its pending entries after a crash and skips them by `event_id` (no loss, no duplicate), and drains gracefully on stop;
- a writer service entry point with `/health` (queue length and lag);
- the tests for all of that.

It is **not wired in**: no `AUDIT_MODE=queue`, nothing added to docker-compose, and Redis AOF was not enabled (it is only needed for the queue). The branch's tests need that wiring before they can pass. If Phase 8 shows the sync audit write is a rush-hour bottleneck, this is the prepared remedy.

### Commands
```bash
npm run audit -- verify
npm run audit -- search [--type EVENT] [--user ID|EMAIL] [--from 2026-10-24] [--to 2026-10-25] [--success true|false] [--ip ADDRESS] [--limit N]
npm run audit -- export --out audit.csv [same filters]
npm run admin -- policy show
npm run admin -- policy set max_attempts=3 lockout_minutes=20 --confirm
npm run admin -- role set <ID or email> <student|staff|guest|admin> --confirm
npm run admin -- perm list
npm run admin -- perm grant|revoke <role> <service> --confirm
npm run admin -- history [N]
```
- Inside Docker, prefix with `docker compose exec app`.
- Every change command needs `--confirm`.
- `require_2fa_admin` cannot be changed (FR-A13).
- Out-of-range values are refused by the database's CHECK constraints, with nothing recorded.
- A policy change applies to the next request (no restart).
- A permission change is announced to running app processes, which reload their map at once.
- A role change revokes the user's tickets, so they sign in again.

**CSV export:**
- Columns: `seq, occurred_at, event_type, success, user_id, subject_hash, ip, user_agent, details, row_hash`.
- Standard CSV quoting, plus formula-injection protection: a cell starting with `=` `+` `-` `@`, a tab or a carriage return gets a leading `'`. This matters because the user agent of a failed login is attacker-controlled.
- An export is itself audited; if that record cannot be written, the file is deleted and the command fails.

### Measured numbers
- **`verify` speed** (test database, this laptop, 3 runs each, pages of 5,000 rows):

| Rows | Median | Runs | Rate |
|---|---|---|---|
| 3,000 | **306 ms** | 284 / 306 / 415 ms | ≈ 9,800 rows/s |
| 20,000 | **1,353 ms** | 1,336 / 1,353 / 1,408 ms | ≈ 14,800 rows/s |

  Memory does not grow with the table (rows are streamed page by page). Per the developer's decision, no 100,000-row test was run.
- **Machine load investigation (2026-10-24), before the last runs:**
  - The machine was out of memory: RAM 94% used (0.9 GB of 15.9 GB free), 24 of 32 GB committed, so Windows was paging.
  - CPU was at 100% with no tests running. The biggest users were the ReasonLabs antivirus engine (`rsEngineSvc`, ~20% CPU), Windows Search (`SearchIndexer`, ~18.5%), and Chrome (23 processes, 2.5 GB RAM, ~13% CPU). VS Code used 1.9 GB and the WSL VM that runs Docker 2.0 GB.
  - The four containers together used only ~110 MB.
  - Suggested (not changed): close Chrome/Edge/Antigravity during test runs; exclude the project folder (`node_modules` especially) from the antivirus's real-time scanning and from Windows Search indexing.
- **Final full test run (2026-10-24, end of 3.4):** **unit 131/131, integration 160/160 passed**, 331 s in total (unit 14 s, integration 317 s), no console noise. That is far faster than the 23-minute run earlier the same day, when the machine was heavily loaded.

| Integration suite | Time | Integration suite | Time |
|---|---|---|---|
| auditTools | 65.6 s | mailpit | 14.1 s |
| lockout | 43.3 s | emailOtp | 9.8 s |
| admin2fa | 37.7 s | seed | 6.4 s |
| totp | 36.3 s | register | 6.0 s |
| passwordReset | 35.3 s | accountTicket | 5.7 s |
| auditLog | 20.2 s | permissions | 3.1 s |
| login | 18.8 s | migrations | 3.0 s |
| system | 2.5 s | tickets | 2.0 s |

  The slowest suites are the ones that start CLI processes (auditTools, lockout, admin2fa) or do many bcrypt hashes. The slowest unit suites are authRoutes (6.3 s) and errors (6.0 s).

### Tests added in Phase 3
- **`permissions.test.js`:** seed mapping; every role/service answer; no DB query per check; middleware 200/403/401; a change announced by one process reloads the map in another.
- **`auditLog.test.js`:**
  - every Phase 1/2 flow recorded with IP and user agent;
  - **no secret, code, token or email address in any row**;
  - lockout event;
  - **50 concurrent logins give a gap-free, intact chain**;
  - append-only (UPDATE / DELETE / TRUNCATE rejected);
  - duplicate `event_id` skipped;
  - fail open and fail closed against a real database error.
- **`auditTools.test.js`** (through the real CLI):
  - 3,000-row chain verifies in pages;
  - **edited row, deleted middle row, swapped rows and deleted newest rows are each detected with the exact message shown below**;
  - wrong key detected;
  - search filters;
  - CSV export with a formula-injection user agent;
  - export refused when it cannot be recorded;
  - `policy set` (needs `--confirm`, writes history and audit, applies without restart);
  - `require_2fa_admin` and out-of-range values refused;
  - policy change refused when the audit write fails;
  - `role set` (history, audit, tickets revoked);
  - `perm grant/revoke` (history, audit, live reload);
  - chain still verifies after the admin actions.
- **Unit:** CSV cell escaping, policy-change parsing, the export's filter summary never containing the searched user.

**What failed along the way (all fixed, then the full run above passed):**
- A first integration run with my new tests: 21 of 156 failed.
  - **Test-side mistakes:** hand-built test configs missing the new required `AUDIT_HMAC_KEY`; a TOTP fail-closed test that locked the account in the wrong order; the long all-flows test hitting Jest's 60 s per-test limit on the loaded machine.
  - The queue-mode tests, before that work was moved to its branch.
- **A timing weakness the Part 1 hardening had missed:** a resend-cooldown test assumed a request would arrive within 1 second. It now uses the normal 60 s cooldown and ends it by deleting the Redis key.
- **One real bug, found by the 3.4 tests:** the shared audit search filter was an `async` function returning a knex query builder. A knex builder is "thenable", so awaiting it ran the query instead of returning the builder, and `search`/`export` failed. Fixed by separating the async user lookup from the synchronous filter.
- The Mailpit reachability check in test setup gave up after 3 s on the loaded machine. It now fails at once if Mailpit is not running, and retries only when it is just slow.

### New `.env` line (required from Phase 3)
```
AUDIT_HMAC_KEY=<32 random bytes, base64url>
```
- Generate it with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- It must differ from `CSRF_SECRET`, `TOKEN_HMAC_KEY` and `TOTP_ENC_KEY`. The app, the admin CLI and the audit CLI all refuse to start without it.
- **Keep it safe:** losing or changing it makes existing chains unverifiable.

### How to demonstrate tampering by hand
1. Add `AUDIT_HMAC_KEY` to `.env` (above), then rebuild so the three new migrations run:
   ```bash
   docker compose up --build -d
   ```
2. Create a few events: open http://localhost:3000/login, enter a wrong password once, then sign in correctly. Then check the chain:
   ```bash
   docker compose exec app npm run audit -- search --limit 10
   docker compose exec app npm run audit -- verify
   ```
   Expected: `Checked N rows in … ms (anchor: seq N).` and `OK: the chain is intact up to seq N.`
3. Open psql on the development database:
   ```bash
   docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
   ```
4. Try an ordinary edit first; the database refuses it:
   ```sql
   UPDATE auth_logs SET success = true WHERE seq = 2;
   -- ERROR:  auth_logs is append-only (UPDATE rejected)
   ```
5. Now tamper the way only the table owner can, by switching the trigger off:
   ```sql
   BEGIN;
   ALTER TABLE auth_logs DISABLE TRIGGER auth_logs_no_update_delete;
   UPDATE auth_logs SET details = '{"method": "hacked"}' WHERE seq = 2;
   ALTER TABLE auth_logs ENABLE TRIGGER auth_logs_no_update_delete;
   COMMIT;
   \q
   ```
6. Verify again:
   ```bash
   docker compose exec app npm run audit -- verify
   ```
   It prints `BROKEN at seq 2: row_hash (row content does not match its hash).` and exits with code 1.

Other cases (the exact messages are checked by `auditTools.test.js`):

| Tampering (inside the same `BEGIN; ALTER ... DISABLE TRIGGER ...; ...; ALTER ... ENABLE TRIGGER ...; COMMIT;` wrapper) | What `verify` prints |
|---|---|
| `DELETE FROM auth_logs WHERE seq = 3;` | `BROKEN at seq 3: gap (seq 3 is missing (next is 4)).` |
| Swap two rows: `UPDATE auth_logs SET seq = 999999 WHERE seq = 2; UPDATE auth_logs SET seq = 2 WHERE seq = 3; UPDATE auth_logs SET seq = 3 WHERE seq = 999999;` | `BROKEN at seq 2: prev_hash (row does not link to the previous row).` |
| Delete the newest rows: `DELETE FROM auth_logs WHERE seq > (SELECT max(seq) - 2 FROM auth_logs);` | `BROKEN at seq …: tail (anchor says seq N exists; database ends at N-2).` |
| Run verify with a different `AUDIT_HMAC_KEY` | `BROKEN at seq 1: row_hash …` |

**A tampered development chain stays broken** (the log is append-only by design). To start the development audit log again (as the table owner):
```sql
BEGIN; ALTER TABLE auth_logs DISABLE TRIGGER auth_logs_no_truncate; TRUNCATE auth_logs; ALTER TABLE auth_logs ENABLE TRIGGER auth_logs_no_truncate; COMMIT;
```
then `docker compose exec redis redis-cli DEL cg:audit:head` to clear the anchor.

### Evidence to capture for the report
- `npm run audit -- verify` showing OK, then the BROKEN message after step 5.
- The psql error `auth_logs is append-only (UPDATE rejected)`.
- `npm run audit -- search --limit 10` output (event types, IP, user agent).
- An exported CSV opened in a spreadsheet, showing a `'=...` cell displayed as text.
- `npm run admin -- policy set max_attempts=3 --confirm`, then `npm run admin -- history`, then `npm run audit -- search --type policy_changed`.
- `npm run admin -- perm list`.
- `npm test` summary (unit 131, integration 160) and the per-suite time table above.

---

## Phase 4: Sessions, token, mock portal (2026-10-26, LITE scope)

| Sub-step | Commit | What |
|---|---|---|
| 4.1 | `504ebb7` | JWT session, `sessions` table, sign-out / sign-out everywhere, revocation, recent sign-in check, interim account ticket removed |
| 4.2 | `a850c74` | `/home`, Fees / Hostel / Course registration pages with demonstration data, demo invoices |
| 4.3 | (this commit) | Docs |

**Test-run rule changed (developer, 2026-10-26):** to save time, each sub-step runs only the touched and closest related suites; ONE full run happens at the end of all remaining phases, before merging to `main`. (4.1 still had a full run: unit 134/134, integration 177/177, 218 s.)

### Requirements covered
| ID | Status | Notes |
|---|---|---|
| FR-P1 | Done | Login once: HS256 JWT in an HttpOnly, SameSite=Strict cookie (`cg.session`; `__Host-` prefix and Secure when `COOKIE_SECURE=true`). Pages check signature + expiry + one Redis lookup; **no database query for authentication** (tested by counting queries). |
| FR-P6 | Done | Revocation by `jti` denylist in Redis: sign-out, sign-out everywhere, password reset/change, role change and 2FA reset (CLI). |
| FR-L2 | Done | `sessions` table: user, jti, scope, IP, user agent, start, expiry, revoked time and reason. End = `revoked_at`, or `expires_at` if never revoked; duration = end − start. |
| FR-A10 | Done | Password change (and reset) now signs the user out of **every** session, including other devices. |
| FR-M1, FR-M2 | Done | `/portal/fees`, `/portal/hostel`, `/portal/registration` read seeded DEMONSTRATION data; each checks the token and the role permission, no second sign-in. |
| FR-Z1 | Done for the portal | `requirePermission` on every portal route; admin routes come with the console (Phase 6). |
| FR-A13 | Still PARTIAL | Admin without TOTP gets an **enrolment-only session** (accepted only on the enrolment routes and sign-out). The console itself is Phase 6. |
| FR-M3, FR-Z3 | Not in LITE scope | Step-up OTP on payment and the concurrent-session limit are Phase 7. |

### How the session works
- **Issue:** after a completed sign-in, `sessions.issue()` writes a `sessions` row and signs `{sub, role, scope, jti, iat, exp, iss, aud}` with `JWT_SECRET` (HS256). Lifetime = `policies.session_timeout_min` read at each sign-in (default 30; change with `npm run admin -- policy set session_timeout_min=N --confirm`, no restart). An enrolment-only session lasts at most 10 minutes.
- **Check (`requireSession`):** verify signature, algorithm (`HS256` only), issuer, audience and expiry; then `EXISTS cg:revoked:<jti>` in Redis. Bad or revoked token: GET redirects to `/login`, API calls get 401 `restart`; the bad cookie is cleared.
- **Redis down: fail closed.** If the denylist cannot be read, protected pages return **503** ("Sign-in checks are unavailable right now"), never accept an unchecked token. Sign-in itself still works without Redis for password-only accounts (the session record is in PostgreSQL), but the pages refuse it until Redis is back. Recorded as a limitation: availability of protected pages depends on Redis.
- **Revoke:** the jti goes on the Redis denylist (until the token would expire, plus 5 s) **before** the row is marked revoked, so a database failure cannot leave a working token. Re-running is safe; the count reports only sessions newly ended.
- **Recent sign-in:** security changes (enable 2FA, TOTP enrolment, change password) need a sign-in from the last **10 minutes**; an older but valid session can still view the settings page.
- **Audit events (fail open):** `logout`, `logout_all` (count), `sessions_revoked` (reason, count, actor).

### Decisions
- **CSRF stays bound to the pre-session cookie**, not the JWT `jti`. The pre-session cookie already lasts across sign-in, and every form (forms.js contract) keeps working unchanged; binding to the jti would mean re-issuing the CSRF token at every sign-in and sign-out. Revisit in Phase 9 with HTTPS.
- **`jsonwebtoken` 9.0.3** (published 2025-12-04; dependencies `jws` 4.0.1 2025-12-04, `jwa` 2.0.1 2025-05-07, others 2013–2026-06), pinned exactly. The lock was updated **from the existing lock** inside `node:24-slim`, so only `jsonwebtoken` and its 13 dependencies were added; no existing package moved. (A first attempt that regenerated from `package.json` alone bumped 20+ unrelated packages and was thrown away.)
- **Demo data lives in a migration** (`demo_fees`, `demo_courses`, `demo_hostels`), labelled DEMONSTRATION DATA on every page, with invented hall names ("Hall A (demo)") so nothing can be mistaken for real University data. Invoices (`demo_invoices`) get a reference `CG-YYYY-XXXXXXXX`; there are no bank details and no payment.
- **pages.js untouched:** the security-settings page keeps its middleware slot; app.js now passes the session check into it.

### Tests added or changed
| File | What it proves |
|---|---|
| `sessions.test.js` (new) | Token claims and lifetime; record written without the token; tampered, wrong-key, `alg: none`, expired, wrong-issuer, bad-subject and unknown-scope tokens refused; revoke and revokeUser (other users untouched, expired skipped, counts only new); works without the signing key (CLI); a failed Redis write is recovered later; Redis down makes the check throw; DB constraints; cascade on user delete |
| `sessionFlow.test.js` (new, replaces `accountTicket.test.js`) | Cookie flags and Max-Age from the policy; policy change applies to the next sign-in; settings need a session; email 2FA end to end; **recent sign-in required for changes**; pre-auth ticket refused by settings and session refused by sign-in endpoints; forged and expired tokens refused and cleared; **sign-out makes the copied token useless**; **sign-out everywhere ends other devices only for that user**; **password change signs out every device**; **Redis down = 503**; CSRF still required |
| `portal.test.js` (new) | One sign-in opens Home + all three pages (one session row); level-specific fees and courses; **refused and unauthenticated requests make zero DB queries**; an allowed page queries only its demo table; revoked token and revoked permission take effect at once; demo invoice (unique reference, CSRF and session required); staff see the three services, a guest-role session none; an enrolment-only session cannot open the portal; Redis down = 503 |
| `sessionRoutes.test.js` (unit, replaces `accountTicketRoutes.test.js`) | Route-tree scan: enrolment sessions accepted only on the enrolment routes + sign-out; every security change has the recent-sign-in check; sign-in/recovery endpoints never need a session; no global session middleware |
| Updated | `admin2fa` (enrolment session revoked after enrolment; reset-2fa revokes sessions), `auditTools` (role change signs the user out), `emailOtp` (Redis down: sign-in OK but pages 503), `auditLog`, `migrations`, `config` (JWT_SECRET rules) |

**Results:** 4.1 full run unit 134/134, integration 177/177 (218 s). 4.2: portal + migrations + sessionFlow 33/33, unit 134/134. Two failures in the first 4.1 run were test-side (the migrations table list; the audit test's grouping of CLI rows, now that `reset-2fa` also records `sessions_revoked`). One real bug was caught and fixed: "sign out everywhere" counted already-revoked sessions.

### New `.env` line (required from Phase 4)
```
JWT_SECRET=<32 random bytes, base64url>
```
Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. It must differ from every other key. Changing it signs everyone out. Remove the old `ACCOUNT_TICKET_TTL_MIN` line if present (it is no longer read).

### Demo by hand (log-out demo)
1. Sign in at http://localhost:3000/login (seeded student, e.g. `SCI/2025/0001`). You land on **Home**.
2. Open Fees, Hostel and Course registration: no second sign-in. Generate an invoice on Fees.
3. Sign in as the same student in a second browser. In the first, press **Sign out everywhere**; reload the second browser: back to the sign-in page.
4. `docker compose exec app npm run audit -- search --type logout_all` shows the event; `SELECT jti, revoke_reason, created_at, revoked_at FROM sessions;` shows the records.
5. Stop Redis (`docker compose stop redis`) and reload a portal page: 503. Start it again: the page works.

### Evidence to capture for the report
- Home page and the three portal pages (with the DEMONSTRATION DATA banner); a generated invoice reference.
- The second-browser sign-out-everywhere demo.
- `sessions` rows with `revoke_reason` (`logout`, `logout_all`, `password_changed`).
- The 503 page with Redis stopped.
- Test summaries above.
---

## Phase 5: Peak-load core (2026-10-26)

| Sub-step | Commit | What |
|---|---|---|
| 5.1 | `f455579` | Rate limiting per IP and per account; `policies.queue_enabled` |
| 5.2 | `34fcafd` | Waiting room (admission control), `/waiting` page, front-end backoff |
| 5.3 | (this commit) | Docs |

Decisions approved by the developer: own Redis rate limiter (no new packages); 300/min per IP and 10/min per account; a `queue_enabled` switch for baseline-vs-proposed measurements; polling, not SSE. **Policy caching was moved to Phase 8**: tests (and admins) change the policy row directly, so a cache needs cross-process invalidation; we measure the cost of the read first.

### Requirements covered
| ID | Status | Notes |
|---|---|---|
| FR-P2 | Done | Waiting room with signed ticket, position, estimated wait, polling every 3 s; FIFO admission in batches; a ticket expires when its page stops polling. |
| FR-P3 | Done (CLI) | Capacity, batch size and interval from `policies` (live, no restart); staff and admin bypass. The admin console editor is Phase 6. |
| FR-P4 | Done | Rate limits per IP and per account with `Retry-After`; the front end waits and retries with doubling backoff on 429/503. |
| FR-P5 | Still done | A rate-limited or queued request never reaches the credential check, so it can never count toward lockout (tested). |

### Rate limiting
- Fixed 60-second window per key, counted atomically in Redis (Lua `INCR` + `PEXPIRE`), so it is shared by every app process.
- Routes: login (IP + account), register (IP + account), forgot password (IP + account), reset password (IP), second-factor steps (IP; each pre-auth ticket and code also has its own attempt limit).
- **Defaults:** `RATE_LIMIT_IP_PER_MIN=300` (generous, because a whole campus can share one public IP behind NAT), `RATE_LIMIT_ACCOUNT_PER_MIN=10`. Lockout still stops password guessing.
- The account key is a keyed hash of the normalized identifier (case and spaces ignored); Redis never holds the typed ID or email.
- **Redis down: fail open** (request allowed, warning logged). Lockout still applies. The alternative would stop every sign-in during a Redis outage.

### Waiting room
- **"Sign-ins in progress"** = live admission passes (`cg:wr:active`). `POST /auth/login` needs a pass when `queue_enabled` is true:
  - a pass already held (cookie `cg.admit`, signed), or
  - one taken at once if there is room **and nobody is waiting** (no queue-jumping), or
  - none, for staff and admin (looked up only when the system is full).
  - Otherwise: **503** `{ queued: true, redirect: "/waiting" }` with `Retry-After` = the interval.
- **Queue:** `/waiting` takes a signed ticket (cookie `cg.wr`) and polls `/queue/status` every 3 s for position and estimated wait (= whole batches ahead × interval).
- **Admitter:** every app process ticks each second; the one that wins the interval slot (`SET cg:wr:tick NX PX interval`) admits up to `queue_batch` tickets from the head of the queue, within capacity. With several processes, exactly one batch per interval.
- **Expiry:** a ticket not polled for 30 s (`QUEUE_TICKET_TIMEOUT_SEC`) is dropped and the others move up; an admitted place not claimed within 30 s is given back; a pass ends when the sign-in completes or after 120 s (`QUEUE_PASS_TTL_SEC`).
- **Redis down: fail open** (sign-in allowed, logged): the waiting room cannot work without Redis, and stopping all sign-ins would be worse. Protected pages still fail closed (Phase 4).
- **Baseline vs. proposed:** `npm run admin -- policy set queue_enabled=false --confirm` turns admission control off without a restart (used for the Phase 8 comparison).
- **Known trade-off:** when the system is full, the response for a staff/admin ID differs from a student ID (staff skip the queue), which reveals that an ID belongs to staff. Only while the system is full, and staff IDs are not secret; accepted.

### Tests
| File | What it proves |
|---|---|
| `rateLimit.test.js` (new) | 4th attempt per account → 429 + Retry-After and **not counted toward lockout**; account limit follows the account however it is typed; per-IP flood across many accounts limited; only keyed hashes in Redis; register / forgot / second-factor limited; window reset; **Redis down = fail open** |
| `waitingRoom.test.js` (new) | Passes until capacity, then queue; **FIFO admission in batches within capacity**; **no queue-jumping**; **ticket expiry when polling stops**; unclaimed admission given back; pass expiry; forged or wrong-key tickets refused; ETA formula; only random ids in Redis; through the app: queued 503 with Retry-After and nothing counted; a completed sign-in frees its place; full flow join → position → admitted → sign in; staff/admin bypass; `queue_enabled=false` never queues; capacity change applies live; **Redis down = fail open** |

**Results:** 5.1: rateLimit + login + lockout + migrations 33/33; 5.2: waitingRoom + login + lockout + emailOtp + sessionFlow 58/58; unit 134/134 each time. (Developer's rule from 2026-10-26: touched suites per sub-step, ONE full run at the end of all phases.) Two test-side mistakes in the first waiting-room run were fixed (a fake clock let a ticket go stale; a cookie helper read the first of two `Set-Cookie` headers); no code changes were needed.

### Optional `.env` lines (defaults shown)
```
RATE_LIMIT_IP_PER_MIN=300
RATE_LIMIT_ACCOUNT_PER_MIN=10
QUEUE_PASS_TTL_SEC=120
QUEUE_TICKET_TIMEOUT_SEC=30
```

### Demo by hand
1. Make the room tiny: `docker compose exec app npm run admin -- policy set queue_capacity=1 queue_batch=1 queue_interval_sec=10 --confirm`.
2. Browser A: enter a seeded student ID with a wrong password (takes the only place and keeps it).
3. Browser B (another student): sign in → sent to the **waiting room**, position 1, estimated wait 10 s. Within ~2 minutes (A's pass expires) B is admitted and taken to sign-in.
4. `policy set queue_enabled=false --confirm`: B signs in at once (baseline mode). Set it back to `true` and the defaults (`queue_capacity=200 queue_batch=50 queue_interval_sec=5`) afterwards.
5. Rate limit: 11 quick sign-ins for one ID → "Too many attempts. Please wait N s"; the page retries by itself.

### Evidence to capture for the report
- The waiting-room page with position and estimated wait.
- The 429 message and the automatic retry.
- `redis-cli ZCARD cg:wr:queue` / `ZCARD cg:wr:active` during the demo.
---

## Phase 6: Admin console (2026-10-26)

| Sub-step | Commit | What |
|---|---|---|
| 6.1 | `16265e0` | Dashboard (live SSE), users, policies, audit log screens |
| 6.2 | (this commit) | Docs |

Decisions approved by the developer: average sign-in time measured on the server; every admin change needs a sign-in from the last 10 minutes (so an admin who walks away from a signed-in computer cannot have changes made in their name); deactivate/reactivate included.

### Requirements covered
| ID | Status | Notes |
|---|---|---|
| FR-D1 | Done | `/admin` dashboard, updated every 2 s over server-sent events (`/admin/metrics/stream`): sign-ins, failed sign-ins and lockouts in the last minute (from the audit log), active sessions, locked accounts, waiting-room queue length and sign-ins in progress, average sign-in time. |
| FR-D2 | Done | `/admin/users`: search by the start of an ID or email; locked-accounts list; unlock; reset 2FA; deactivate / reactivate; change role. |
| FR-D3 | Done | `/admin/policies`: every policy field (password rules, lockout, session timeout, max sessions, waiting room incl. `queue_enabled`), applied on the next request; change history below. `require_2fa_admin` is not editable. |
| FR-Z5 | Done | Every console change is in `policy_history` (actor `admin:<id>`) and the audit log, in the same transaction (fail closed). |
| FR-L3 | Done | "Verify integrity" button (`POST /admin/logs/verify`), itself audited. |
| FR-L4 | Done | `/admin/logs`: filter by event, user, dates, result, IP (latest 100 shown); CSV download of all matching rows, audited before anything is sent. |
| FR-A6 | Done | Admin unlock from the console (and the CLI). |
| FR-A13 | Done | Every `/admin` route requires an admin account with an authenticator app; the check reads the account from the database, so a forged role in a token is useless. |

### Security rules on the console
- Route chain: session → `requireAdmin2FA` (admin role + TOTP on, from the database) → `admin_console` permission. Changes add CSRF and the 10-minute recent sign-in.
- Role change, 2FA reset and deactivation sign the user out everywhere (sessions revoked, `sessions_revoked` audited).
- An admin cannot deactivate their own account or remove their own admin role (to avoid locking everyone out).
- Log filters are validated (event type from the known list, IP pattern, real dates) before reaching the query builder, which uses bound parameters anyway.
- New audit event: `admin_user_status` (actor, active), fail closed.

### Sign-in time measurement
`POST /auth/login` records the server time of the password step (bcrypt, lockout, audit) into a per-minute Redis bucket (`cg:metrics:login_time:<minute>`, sum and count, kept 3 minutes). The dashboard shows the average over the current and previous minute. Phase 8 uses the same figure in calibration.

### Tests
`adminConsole.test.js` (new, 16 tests): access (admin with TOTP; refused without a session, for a student, for an admin without TOTP, for an enrolment-only session, and for a student token claiming role "admin"); CSRF and recent sign-in on changes; dashboard snapshot figures (1 sign-in, 5 failures, 1 lockout, 1 session, 1 locked, 1 queued, timing > 0) and the SSE stream; user search, unlock (audited with the admin as actor), deactivate (signed out everywhere, cannot sign in) and reactivate, self-protection, role change (history, signed out), 2FA reset; policy change applies at once (lock after 3 instead of 5), history, out-of-range refused, `require_2fa_admin` not editable; audit log filter, CSV export (audited), Verify OK and then BROKEN after a direct database edit; hostile filter values.

**Results:** adminConsole 16/16; login, portal, admin2fa, waitingRoom 46/46; unit 135/135 (the route-scan test now also checks that every `/admin` route needs a session and every admin change a recent sign-in).

### Demo by hand
1. Give the seeded admin an authenticator app: sign in as `ADMIN0001`, scan the QR code, confirm, sign in again with the code.
2. Home → **Admin console**. Leave the dashboard open in one window.
3. In another browser, sign in as a student with a wrong password 5 times: the dashboard shows the failures, 1 lockout and 1 locked account within 2 s.
4. **Users** → unlock that student. **Policies** → set `max attempts` to 3 → the next lockout happens after 3 failures. The history table shows both changes.
5. **Audit log** → Verify integrity (OK) → download CSV.

### Evidence to capture for the report
- The dashboard during the rush-hour demo (Phase 8).
- The users page with a locked account, before and after unlock.
- The policy editor and its history.
- Verify integrity OK, and BROKEN after a direct database edit (Phase 3 tamper steps).