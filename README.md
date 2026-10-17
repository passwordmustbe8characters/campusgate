# CampusGate

A centralized **AAA (Authentication, Authorization, Accounting)** system for a university network, built as a BSc project: *Development of a Network Authentication System for Secure Access.* The case study is student portals failing at rush hour (fees, hostel opening, freshers); the system aims to stay secure **and** reachable under peak load.

- Requirements: [docs/SPEC.md](docs/SPEC.md)
- Build progress, decisions, and measured numbers: [docs/PROGRESS.md](docs/PROGRESS.md)

**Stack:** Node.js 24 LTS, Express 5, PostgreSQL 17, Redis 8, Docker Compose.

## Quick start (Docker)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
cp .env.example .env        # then edit every "change-me" value
docker compose up --build
```

This starts PostgreSQL, Redis, Mailpit and the app; the app runs pending migrations and then listens on port 3000.

**Email in development:** every email the app sends (sign-in codes, reset links, "password changed" notices) goes to Mailpit, a local mail catcher. Nothing leaves your machine. Open **http://localhost:8025** to read them.

Load the demo data (2,000 fake student records, 1,500 of them with accounts, plus `STAFF0001` and `ADMIN0001`). The first run takes about 80 s because every account is hashed at the real bcrypt cost:

```bash
docker compose exec app npm run seed
```

Then open http://localhost:3000/login (or `/register` for a free record such as `SCI/2025/0061`). Seeded passwords are the `SEED_*_PASSWORD` values in your `.env`.

Check it is up:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime_s":5,"checks":{"postgres":{"status":"ok","latency_ms":1.2},"redis":{"status":"ok","latency_ms":0.4}}}
```

`/health` returns **200** when PostgreSQL and Redis both respond and **503** (`"status":"degraded"`) when either is down.

Stop with `docker compose down` (add `-v` to delete the database volume).

## Running the app on the host (for development)

Start only the databases in Docker, then run Node directly:

```bash
cp .env.example .env               # DATABASE_URL / REDIS_URL / SMTP_HOST point at localhost
docker compose up -d postgres redis mailpit
npm install
npm run migrate
npm run dev                        # restarts on file changes
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (nodemon) |
| `npm start` | Start the server |
| `npm test` | Unit tests, then integration tests (integration needs `docker compose up -d postgres redis mailpit`) |
| `npm run test:unit` | Unit tests only, with stand-ins; no services needed |
| `npm run test:integration` | Integration tests against the real PostgreSQL, Redis and Mailpit. Uses a separate `<db>_test` database (recreated each run) and Redis DB 15, so dev data is untouched. **It empties the Mailpit inbox.** Fails, never skips, if a service is down |
| `npm run migrate` | Apply database migrations (knex) |
| `npm run seed` | Seed student records and accounts (counts from `SEED_REGISTERED_STUDENTS` / `SEED_FREE_STUDENTS`). Safe to re-run |
| `npm run admin -- unlock <ID or email>` | Unlock a locked account (also `status <ID or email>` and `locked`) |
| `npm run admin -- reset-2fa <ID or email> --confirm` | Lost device: turn two-step sign-in off and delete the authenticator secret and backup codes (admins must re-enrol at next sign-in) |
| `npm run bench:bcrypt [samples]` | Time bcrypt at costs 10, 11, 12 (run it in the container: `docker compose run --rm --no-deps app node scripts/bcrypt-bench.js 30`) |
| `npm run loadtest` | Phase 8, not implemented yet |
| `npm run calibrate` | Phase 8, not implemented yet |

## Changing dependencies

The Dockerfile uses `npm ci`, which needs `package-lock.json` to match the image's npm exactly. After editing dependencies in `package.json`, update the lock file inside the image rather than with your local npm (copying the existing lock keeps unrelated versions unchanged):

```bash
docker run --rm -v "$PWD:/src" node:24-slim sh -c \
  'mkdir /w && cp /src/package.json /src/package-lock.json /w/ && cd /w && npm install --package-lock-only --no-audit --no-fund && cp package-lock.json /src/package-lock.json'
npm ci        # then sync your local node_modules
```

## Configuration

All settings come from environment variables (see [.env.example](.env.example)). The app refuses to start and lists every problem if a required variable is missing or invalid. Secrets live only in `.env`, which is git-ignored.

`TOKEN_HMAC_KEY` and `TOTP_ENC_KEY` are required (32 random bytes each, base64url; the command to generate one is in `.env.example`). **Keep `TOTP_ENC_KEY` safe:** if it is lost or changed, stored authenticator secrets cannot be read and those users must be reset with `reset-2fa`.

The Jest scripts run with `node --experimental-vm-modules`, because otplib's CommonJS build loads an ESM-only dependency. This affects tests only; the app itself runs on plain Node.

`UV_THREADPOOL_SIZE` controls libuv's thread pool, where bcrypt hashing runs. It must be set in the environment before Node starts (setting it in code later has no effect). The value in use is logged at startup.

## Repository layout

```
app/src/   config, logger, app factory, server, routes/, controllers/, services/, middleware/, policies/, db/
app/views/ EJS pages     app/public/  CSS + JS
db/        migrations/ seed/ (seed/lib: data generator and seeding logic)
scripts/   admin CLI, bcrypt benchmark
tests/     unit/ (stand-ins) and integration/ (real PostgreSQL + Redis)
docs/      SPEC.md, PROGRESS.md
sim/       OMNeT++ project (maintained by the developer)
```
