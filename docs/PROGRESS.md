# Build Progress

Plain record of what has been built, which requirements it covers, decisions made, and measured numbers. Written for the teammate writing the project report.

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Scaffold | Done (Docker verified 2026-10-11) |
| 1 | Core authentication | Done 2026-10-11 (FR-A6 partial until Phases 3 and 6) |
| 2 | Second factors and recovery | Not started |
| 3 | Authorization and audit logs | Not started |
| 4 | Sessions, token, mock portal | Not started |
| 5 | Peak-load core | Not started |
| 6 | Admin console | Not started |
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

## Open items handed to later phases

| For phase | Item |
|---|---|
| 3 | Write admin unlocks to the tamper-evident audit log (unlock is CLI-only and only in the app log for now). Also log registration/login/lockout events there (currently pino log lines only). |
| 4 | Bind CSRF tokens to the session (JWT `jti`) instead of the pre-session cookie. |
| 5 | Cache the `policies` row (per process or in Redis) **with invalidation on change**, instead of reading it from PostgreSQL on every login/registration. Measure before and after. |
| 5 | Front-end exponential backoff on 429/503 in `app/public/js/forms.js`. |
| 6 | Admin console unlock button and `/admin/users/:id/unlock`, calling the existing `unlockUser` service. |
| 7 | Enforce email verification (FR-A2); `users.email_verified` already exists and is `false` for new sign-ups. |
| 9 | Check the registration privacy notice wording against the Nigeria Data Protection Act 2023 (NFR-5). |

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
