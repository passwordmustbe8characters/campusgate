# CLAUDE.md: Build Brief

## Project
A centralized **AAA (Authentication, Authorization, Accounting)** system for a university network, built as a BSc project: *Development of a Network Authentication System for Secure Access.*
**Case study:** university student portals fail at rush hour (fees, hostel opening, freshers). The system must stay **secure and reachable under peak load** using a login-once token, a waiting room (admission control), rate limiting, and adaptive security.

The full requirements are in `docs/SPEC.md` (requirement IDs like FR-A1, NFR-3). **That file is the source of truth.** This file tells you how to work and in what order.

You build the **Node.js app only**. The OMNeT++ simulation lives in `/sim` and is written by the developer; do not modify it. Your job includes producing the **measurement data** the simulation needs (Phase 8).

## Stack
Node.js (current LTS), Express, PostgreSQL, Redis, Docker Compose. Plain HTML/CSS/vanilla JS (or EJS) for the UI: **no heavy front-end framework** (low-bandwidth, mobile-first). Check each package's current docs before using it, and don't assume APIs from memory.
Suggested libraries: express, helmet, express-rate-limit (Redis store), express-validator, bcrypt, jsonwebtoken, otplib, qrcode, nodemailer, pg + knex (or node-pg-migrate), ioredis, a maintained CSRF library (`csurf` is deprecated), pino, jest + supertest, autocannon or k6 for load tests.

## How to work
1. **One phase per session.** At the start of each phase, state your plan and the files you'll touch, then build. Do not try to build everything at once.
2. **Don't invent requirements.** If the spec is ambiguous or contradictory, ask the developer. Don't add features that aren't in the spec.
3. **Small, working steps.** Run the app and the tests after each step. Commit with clear messages at the end of each task.
4. **Tests with the code.** Every auth rule gets a test (jest + supertest).
5. **Explain what you did** at the end of each phase in `docs/PROGRESS.md`: what was built, which requirement IDs it covers, decisions made, commands to run, what to screenshot, and any measured numbers. A teammate writes the project report from this file, so keep it accurate and plain.
6. **Report honestly.** If something doesn't work or is only partly done, say so. Never claim a test passed without running it.

## Non-negotiable security rules
- Passwords hashed with **bcrypt** (cost chosen by measurement, about 10 to 12). Never store or log plain passwords, OTPs, tokens, or TOTP secrets in plain text (encrypt TOTP secrets at rest).
- **Parameterized queries only.** Validate and escape all input and output.
- **Generic login errors** (never reveal whether a user exists).
- **Temporary lockout**, not permanent. Count only *credential* failures, never timeouts or server errors (FR-P5).
- OTPs and reset tokens: stored hashed, single-use, expiring, attempt-limited.
- Secrets only in environment variables; provide `.env.example`; never commit `.env`.
- Security headers (helmet), CSRF protection for cookie auth, HttpOnly + SameSite cookies, `Secure` when HTTPS.
- Admin accounts must have 2FA enabled before reaching the console.

## Known gotchas (read before coding)
- **bcrypt runs on libuv's thread pool** (default size 4). It becomes the bottleneck at peak load. Make `UV_THREADPOOL_SIZE` configurable and measure.
- **Clustering breaks in-memory state.** The waiting room, rate limits, and token denylist must live in **Redis**, never in process memory.
- **Audit log hash chain:** each row stores `prev_hash` and `row_hash`. Concurrent inserts can fork the chain, so serialize writes (a transaction with a lock, or a single insert that reads the latest hash safely) and test with concurrent logins.
- **Waiting room tickets** are signed, expire if the client stops polling, and are admitted FIFO. Staff/admin bypass.
- **Never hash passwords on the main event loop synchronously.** Use the async API.
- The seed script (about 2,000 fake students) must hash passwords efficiently; allow a low cost factor **only** for seeding or tests via an env flag, and never in the app's normal config.

## Repository layout
```
/app        src/{routes,controllers,services,middleware,db,queue,policies}  views/  public/
/db         migrations/  seed/
/loadtest   scenarios + virtual-student generator
/radius     FreeRADIUS config (last phase)
/sim        OMNeT++ project (developer only, do not edit)
/docs       SPEC.md  PROGRESS.md  diagrams  calibration.json
docker-compose.yml  .env.example  README.md
```
Create npm scripts: `dev`, `start`, `test`, `migrate`, `seed`, `loadtest`, `calibrate`.

## Phases
Mark tasks done in `docs/PROGRESS.md`. Each phase ends with passing tests and a short entry there.

### Phase 0: Scaffold
- Docker Compose (app, PostgreSQL, Redis), config loader, health endpoint `/health`, logging, error handler, migrations setup, README with run instructions.
- **Done when:** `docker compose up` starts everything and `/health` returns OK.

### Phase 1: Core authentication (FR-A1, A3 to A6)
- Schema: users, roles, student_records, policies. Seed roles and ~2,000 fake students.
- Register (validated against `student_records`), login with generic errors, bcrypt, password policy and blocklist, temporary lockout and admin unlock, basic UI pages.
- **Done when:** register, login, 5 failures lock, unlock works, all with tests.

### Phase 2: Second factors and recovery (FR-A7 to A10, A13, A14)
- Email OTP (delivery interface with `console`, `email`, `sms-mock` drivers), TOTP enrolment with QR and 8 hashed backup codes, password reset by expiring token, change password.
- **Done when:** each flow works end to end, OTP expiry and attempt limits tested.

### Phase 3: Authorization and audit logs (FR-Z1, Z5, FR-L1 to L4)
- Roles, services, role_permissions, permission middleware. Audit log for every event with the tamper-evident hash chain, verify endpoint, filter and CSV export. Policy changes logged with history.
- **Done when:** editing a log row directly in the DB makes the integrity check fail.

### Phase 4: Sessions, token, mock portal (FR-P1, FR-M1, M2)
- JWT (short-lived) in HttpOnly cookie, session records, logout, logout-all. Three protected pages (Fees, Hostel, Course Registration) reading seeded data, verified by token only (no per-page DB hit for auth).
- **Done when:** one login opens all three pages; revoked or expired tokens are rejected.

### Phase 5: Peak-load core (FR-P2 to P5)
- Rate limiting (per IP and per account, with `Retry-After`), front-end backoff, **waiting room** in Redis (capacity, batch size, interval from policies; ticket, position, estimated wait via polling or SSE; staff/admin bypass).
- **Done when:** with capacity set low, extra users see the waiting room and are admitted in order; tests cover ticket expiry and ordering.

### Phase 6: Admin console (FR-D1 to D3, FR-Z5)
- Dashboard with live metrics via SSE (logins/min, active sessions, queue length, failures, lockouts, average login time), user management, policy editor with history, logs viewer.
- **Done when:** changing a policy in the UI changes system behavior without a restart.

### Phase 7: P1 features
- Email verification (FR-A2), risk score and policy decision (FR-A11), new-device email alert (FR-A12), access windows (FR-Z2), concurrent session limit (FR-Z3), guest vouchers (FR-Z4), step-up OTP on mock fees payment (FR-M3), token revocation by `jti` in Redis (FR-P6), suspicious-activity panel (FR-D5), access-window and voucher admin screens (FR-D4).
- **Done when:** each has tests and an acceptance check from the spec.

### Phase 8: Load, clustering, measurement (FR-P7, P8, NFR-7)
- Clustering or PM2 with Redis shared state. Load-test scenarios (ramp to N users with retries) and the admin "simulate rush hour" button that launches the generator.
- **`calibrate` script:** measure and write `docs/calibration.json`: bcrypt time per login at the chosen cost, DB time, OTP step time, and throughput and success rate at 1, 2, and 4 workers (with `UV_THREADPOOL_SIZE` noted). The developer feeds these numbers into the OMNeT++ model. Also export the load-test results as CSV for validation.
- **Done when:** results are reproducible, and baseline (waiting room off) vs. proposed (on) is measurable.

### Phase 9: Hardening and documentation
- Security tests: brute-force script, SQL injection attempts, missing-CSRF attempt, OWASP ZAP baseline notes, confirm no secrets in logs. HTTPS with a local certificate. OpenAPI docs, README, architecture and sequence diagram notes, final `PROGRESS.md`.

### Phase 10 (last): FreeRADIUS (FR-R1 to R3)
- FreeRADIUS in Docker using its REST module to call `POST /radius/authorize` (verifies credentials, lockout, role, window, logs the event). Provide a `radtest` demo and instructions. Check the FreeRADIUS docs for your version's REST module syntax rather than guessing.

## Definition of done (whole project)
1. A new student registers, logs in with OTP, and opens Fees, Hostel, and Registration with one login.
2. Five wrong passwords lock the account temporarily; admin sees and unlocks it.
3. Under the rush-hour simulator, the waiting room engages and the dashboard shows queue length with stable response; with it off, the same load visibly degrades.
4. The audit log shows every step; the integrity check passes and fails if a row is edited.
5. `docker compose up` plus the seed script reproduces the demo from scratch.

## First message to send in a new session
> Read CLAUDE.md and docs/SPEC.md. We are starting Phase 0. Propose your plan and the file structure, then build it and update docs/PROGRESS.md.
