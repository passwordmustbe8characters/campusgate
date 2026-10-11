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

This starts PostgreSQL, Redis, and the app; the app runs pending migrations and then listens on port 3000.

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
cp .env.example .env               # DATABASE_URL / REDIS_URL point at localhost
docker compose up -d postgres redis
npm install
npm run migrate
npm run dev                        # restarts on file changes
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (nodemon) |
| `npm start` | Start the server |
| `npm test` | Run the jest + supertest suite (no database needed for Phase 0 tests) |
| `npm run migrate` | Apply database migrations (knex) |
| `npm run seed` | Run seed files (student records arrive in Phase 1) |
| `npm run loadtest` | Phase 8, not implemented yet |
| `npm run calibrate` | Phase 8, not implemented yet |

## Changing dependencies

The Dockerfile uses `npm ci`, which needs `package-lock.json` to match the image's npm exactly. After editing dependencies in `package.json`, regenerate the lock file inside the image rather than with your local npm:

```bash
docker run --rm -v "$PWD:/src" node:24-slim sh -c \
  'mkdir /w && cp /src/package.json /w/ && cd /w && npm install --package-lock-only --no-audit --no-fund && cp package-lock.json /src/package-lock.json'
npm ci        # then sync your local node_modules
```

## Configuration

All settings come from environment variables (see [.env.example](.env.example)). The app refuses to start and lists every problem if a required variable is missing or invalid. Secrets live only in `.env`, which is git-ignored.

`UV_THREADPOOL_SIZE` controls libuv's thread pool, where bcrypt hashing runs. It must be set in the environment before Node starts (setting it in code later has no effect). The value in use is logged at startup.

## Repository layout

```
app/src/   config, logger, app factory, server, routes/, middleware/, db/ (more folders added per phase)
db/        migrations/ seed/
tests/     jest + supertest
docs/      SPEC.md, PROGRESS.md
sim/       OMNeT++ project (maintained by the developer)
```
