# Build Progress

Plain record of what has been built, which requirements it covers, decisions made, and measured numbers. Written for the teammate writing the project report.

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Scaffold | Done (Docker verified 2026-10-11) |
| 1 | Core authentication | Not started |
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
