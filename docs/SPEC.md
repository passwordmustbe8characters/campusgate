# Spec Sheet and Build Guide
## Network Authentication System for Secure Access: University Peak-Load Case Study

**Stack:** Node.js (Express), PostgreSQL, Redis, OMNeT++ (+ INET), FreeRADIUS | **Window:** 2 to 4 weeks | **Scope:** full, nothing cut

> **Build status** of each requirement (Done / PARTIAL / not started) is kept in `docs/PROGRESS.md`, per phase. As of Phase 4: FR-P1, FR-P6, FR-L2, FR-A10, FR-M1 and FR-M2 are done; FR-Z1 is done for the portal (admin routes come with Phase 6).

> **How to read priorities.** Everything below stays in scope. Tags only set the *order of work* so that if time runs short, the project still defends well: **P0** = core, must work for the demo; **P1** = strengthens the thesis; **P2** = extra credit, build last. Requirement IDs (FR-A1, NFR-3, etc.) are there so your colleague can reference them in the report.

---

## 0. How this build explains the project topic

**Topic:** *Development of a Network Authentication System for Secure Access.*

| Phrase in the topic | What it means here | Where it appears in the build |
|---|---|---|
| **Network** | Users reach services over a (Wi-Fi/LAN) network through a gatekeeper (NAS) | OMNeT++ model of clients, access point, auth server; FreeRADIUS integration |
| **Authentication** | Proving who you are before access | Password + bcrypt, email OTP, TOTP, lockout, risk checks |
| **Authorization** (the "A" in AAA) | What you may do after proof | Roles, permissions per service, access windows, device limits |
| **Accounting** (the third "A") | Recording what happened | Tamper-evident audit logs, session records, dashboard, export |
| **Secure** | Resists attack and misuse | Hashing, rate limiting, CSRF/headers, lockout, attack simulations |
| **Access** | Reaching real resources | Mock school portal (fees, hostel, registration) opened by the token |
| **Case study** | Why it matters | Rush-hour portal failure (fees, hostel, freshers): security that *stays available* under load |

**Thesis sentence for the defense:** *A centralized AAA system for a university can stay both secure and reachable at peak load, using a login-once token, admission control, and adaptive security, which we demonstrate with a working prototype and validate with OMNeT++ simulation.*

---

## 1. Users and roles

| Role | Can do |
|---|---|
| **Student** | Register (matric number), log in, use portal services, manage own security settings |
| **Staff** | Same, plus staff services; may bypass the waiting room |
| **Guest / contractor** | Time-limited voucher access to limited services |
| **Admin** | Manage users, roles, policies, windows, vouchers, logs; always requires 2FA |

---

## 2. Functional requirements

### Module A: Authentication
| ID | Requirement | Pri |
|---|---|---|
| FR-A1 | Registration with matric/staff ID, email, password; matric validated against a seeded "student records" table | P0 |
| FR-A2 | Email verification link before the account becomes active | P1 |
| FR-A3 | Password policy from admin settings (min length, uppercase, special char); reject common/breached-style passwords via a small blocklist | P0 |
| FR-A4 | Passwords hashed with bcrypt (cost chosen by measurement, about 10 to 12) | P0 |
| FR-A5 | Login with generic error messages (no "user not found" leak) | P0 |
| FR-A6 | Temporary lockout after N failures (lockout minutes configurable); admin can unlock | P0 |
| FR-A7 | Email OTP: 6 digits, hashed in DB, 5-minute expiry, max 3 attempts | P0 |
| FR-A8 | TOTP (authenticator app) enrolment with QR code; 8 one-time **backup codes** (hashed) | P0 |
| FR-A9 | Password reset by emailed expiring single-use token | P0 |
| FR-A10 | Change password; logs out other sessions | P1 |
| FR-A11 | Risk score at login (new IP, off-hours, recent failures, new user-agent); policy decides: allow, require OTP, or block | P1 |
| FR-A12 | Email notification on login from a new device/IP | P1 |
| FR-A13 | Admin accounts must have 2FA enabled to access the console | P0 |
| FR-A14 | OTP delivery is an interface (`console`, `email`, `sms-mock`) so channels can be swapped and tested | P1 |

### Module B: Authorization
| ID | Requirement | Pri |
|---|---|---|
| FR-Z1 | Roles and a role-to-service permission table; every protected route checks it | P0 |
| FR-Z2 | **Access windows** by level/faculty/service (for example 400L fees 8:00 to 10:00); user sees when their window opens | P1 |
| FR-Z3 | Max concurrent sessions/devices per user (policy); oldest evicted or new login rejected | P1 |
| FR-Z4 | Guest vouchers: admin creates a code with role, services, and expiry; auto-expires | P1 |
| FR-Z5 | Admin changes to roles/policies are themselves logged | P0 |

### Module C: Accounting (audit)
| ID | Requirement | Pri |
|---|---|---|
| FR-L1 | Log every auth event: attempt, success/fail, OTP sent/verified, lockout, reset, logout, policy change, admin action (with IP, user-agent, timestamp) | P0 |
| FR-L2 | Session records (start, end, duration, IP) | P0 |
| FR-L3 | **Tamper-evident logs:** each row stores a hash of (previous hash + row); an admin "Verify integrity" button recomputes the chain | P1 |
| FR-L4 | Log search/filter and CSV export | P0 |
| FR-L5 | Configurable log retention | P2 |

### Module D: Peak-load features
| ID | Requirement | Pri |
|---|---|---|
| FR-P1 | **Login once:** signed JWT in an HttpOnly cookie; portal services verify the signature, with no DB hit per page | P0 |
| FR-P2 | **Waiting room:** when in-progress logins exceed a threshold, users get a signed ticket, queue position, estimated wait (auto-refresh via polling/SSE); admitted FIFO in batches; ticket expires if the user vanishes | P0 |
| FR-P3 | Admin-set capacity, batch size, admit interval; staff/admin bypass | P0 |
| FR-P4 | Rate limiting per IP and per account, with `Retry-After`; front-end exponential backoff on 429/503 | P0 |
| FR-P5 | Lockout rules must not punish slow-system failures (count only credential failures, not timeouts) | P0 |
| FR-P6 | Token revocation (logout, password change, admin kill) via `jti` denylist in Redis | P1 |
| FR-P7 | Multi-process serving (Node cluster or PM2) with shared state in Redis; measured effect on throughput | P1 |
| FR-P8 | **"Simulate rush hour"** admin button that launches a virtual-student load generator against the live system | P1 |

### Module E: Mock school portal
| ID | Requirement | Pri |
|---|---|---|
| FR-M1 | Three protected pages: **Fees**, **Hostel**, **Course Registration**, each reading from seeded data | P0 |
| FR-M2 | Each page verifies the token and the user's role/window; no second login | P0 |
| FR-M3 | Fees page triggers a step-up OTP before "payment" (mock) to demonstrate adaptive 2FA | P1 |

### Module F: Admin console
| ID | Requirement | Pri |
|---|---|---|
| FR-D1 | Live dashboard (SSE): logins/min, active sessions, queue length, failures, lockouts, average login time | P0 |
| FR-D2 | User management: search, activate/deactivate, unlock, reset, change role | P0 |
| FR-D3 | Policy editor (password rules, lockout, session timeout, 2FA mandatory, waiting-room settings) with change history | P0 |
| FR-D4 | Access-window and voucher management | P1 |
| FR-D5 | Suspicious-activity panel (repeated failures, new IP bursts) | P1 |

### Module G: Network integration (FreeRADIUS)
| ID | Requirement | Pri |
|---|---|---|
| FR-R1 | Run FreeRADIUS (Docker); use its REST module to call `POST /radius/authorize` on the Express app, which verifies credentials, lockout, role, and window, and logs the event | P2 |
| FR-R2 | Demonstrate with `radtest` (Access-Accept / Access-Reject); screenshot for the report | P2 |
| FR-R3 | If a captive-portal/router is available, point it at FreeRADIUS and demo real network login | P2 |

*Check the FreeRADIUS documentation for your version's REST module configuration. Using REST avoids having to make FreeRADIUS understand your bcrypt hash format.*

---

## 3. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Security headers & input validation:** helmet, strict validation (for example express-validator), parameterized queries, output escaping |
| NFR-2 | **CSRF protection** for cookie auth (SameSite cookies plus a CSRF token library; `csurf` is deprecated) |
| NFR-3 | **Secrets in environment variables**; no secrets in the repo; `.env.example` provided |
| NFR-4 | **HTTPS** in the demo using a local certificate (for example mkcert) |
| NFR-5 | **Privacy:** collect minimum data; consent notice at registration; never log passwords/OTPs; check Nigeria Data Protection Act 2023 obligations before final wording |
| NFR-6 | **Low-bandwidth, mobile-first UI:** no heavy front-end framework, pages kept small, usable on a phone |
| NFR-7 | **Performance:** set targets *after* measuring (login time, logins/sec at 1/2/4 workers); report measured values only |
| NFR-8 | **Reliability:** graceful errors, health endpoint (`/health`), no stack traces to users |
| NFR-9 | **Reproducibility:** `docker compose up` starts app, PostgreSQL, Redis (and FreeRADIUS); seed script creates about 2,000 fake students and sample data |
| NFR-10 | **Documentation:** README, API docs (OpenAPI/Swagger), architecture diagram |
| NFR-11 | **Testing:** automated tests for core flows (see Section 8) |

---

## 4. Screens

**Public/student:** Register, Verify email, Login, OTP/TOTP entry, Waiting room, Forgot/Reset password, Portal home (Fees, Hostel, Course Registration), Security settings (enrol TOTP, backup codes, change password, active sessions with "log out all"), Access-window message page.
**Admin:** Dashboard, Users, Roles & permissions, Policies, Access windows, Vouchers, Logs (filter/export/verify integrity), Suspicious activity, Rush-hour simulator.

---

## 5. Data model

`users` (id, matric_or_staff_id, username, email, email_verified, password_hash, role_id, level, faculty, is_active, two_factor_enabled, totp_secret_enc, failed_attempts, locked_until, last_login, created_at)
`student_records` (matric_no, name, level, faculty): seeded "registry" used to validate sign-up
`roles` (id, name) | `services` (id, name) | `role_permissions` (role_id, service_id)
`policies` (id, min_length, require_upper, require_special, max_attempts, lockout_minutes, session_timeout_min, require_2fa_admin, max_sessions, queue_capacity, queue_batch, queue_interval_sec, updated_by, updated_at) + `policy_history`
`access_windows` (id, service_id, level, faculty, start_time, end_time)
`otp_codes` (id, user_id, code_hash, channel, expires_at, attempts_used, used)
`totp_backup_codes` (id, user_id, code_hash, used)
`password_reset_tokens` (id, user_id, token_hash, expires_at, used) | `email_verifications` (same shape)
`sessions` (id, user_id, jti, ip, user_agent, created_at, expires_at, revoked_at)
`guest_vouchers` (id, code_hash, role_id, services, expires_at, created_by, used_by)
`auth_logs` (id, user_id, timestamp, event_type, ip, user_agent, success, details, prev_hash, row_hash)
Redis: waiting-room queue and tickets, rate-limit counters, token denylist.

---

## 6. API outline

**Auth:** `POST /auth/register` `/auth/verify-email` `/auth/login` `/auth/otp` `/auth/totp/enrol` `/auth/totp/verify` `/auth/logout` `/auth/logout-all` `/auth/password/forgot` `/auth/password/reset` `/auth/password/change`
**Queue:** `GET /queue/status?ticket=` (or SSE `/queue/stream`)
**Portal:** `GET /portal/fees` `/portal/hostel` `/portal/registration`; `POST /portal/fees/pay` (step-up OTP)
**Admin:** `/admin/users` `/admin/roles` `/admin/policies` `/admin/windows` `/admin/vouchers` `/admin/logs` `/admin/logs/verify` `/admin/metrics/stream` `/admin/simulate`
**Network:** `POST /radius/authorize`; **Ops:** `GET /health`

---

## 7. OMNeT++ specification

**Model:** `Client`, `AccessPoint` (NAS), `WaitingRoom`, `AuthServer` (finite queue, service time), `OTPGateway` (delay/loss), `Attacker`. Messages: AccessRequest, QueueTicket, OTPChallenge, OTPResponse, AccessAccept, AccessReject. Clients time out and retry.

**Calibration inputs (from your real app):** measured bcrypt login time, DB time, OTP step time, throughput at 1, 2, 4 workers (from FR-P7).

| # | Experiment | Vary | Metrics | Pri |
|---|---|---|---|---|
| E1 | Flash crowd, baseline vs. proposed | users 500 to 5,000+, retry on/off | success rate, mean/95th-pct login time, timeouts | P0 |
| E2 | Server scaling | 1, 2, 4 servers | utilization, queue length | P0 |
| E3 | Brute-force attack | lockout on/off, attacker rate | guesses allowed, legit-user impact | P0 |
| E4 | Cost of MFA | password only vs. +OTP vs. +TOTP | added delay, failures | P1 |
| E5 | OTP channel on a bad network | SMS-like delay/loss vs. TOTP | login completion rate | P1 |
| E6 | DoS flood on auth server | attack rate, rate limiting on/off | legit success rate | P1 |
| E7 | Waiting-room tuning | capacity, batch size, interval | wait time vs. stability | P1 |
| E8 | Staggered windows | one window vs. 3 windows | peak load, delay | P2 |

**Rigor:** at least 10 seeds per configuration (`repeat` plus a seed-set), report means with confidence intervals; export with `opp_scavetool` and plot in Python; **validate** by comparing simulated vs. measured results at 2 to 3 load levels from the real load test. State assumptions wherever ICT data is unavailable.

---

## 8. Testing and acceptance

**Automated:** login success/fail, lockout and unlock, OTP expiry/attempt limit, TOTP and backup code, reset token single-use, role/window enforcement, token revocation, log chain verification.
**Load:** autocannon or k6 with a ramp-to-N-users scenario including retries; record success rate and latency percentiles.
**Security (own system only):** brute-force script, SQL injection attempts, missing-CSRF attempt, OWASP ZAP baseline scan, confirm hashes in the DB, confirm no secrets in logs.

**Acceptance (demo-ready means all P0 true):**
1. A new student registers, logs in with OTP, and opens all three portal pages with one login.
2. Five wrong passwords lock the account temporarily; admin sees it and unlocks it.
3. Under the rush-hour simulator, the waiting room engages and the dashboard shows queue length and stable response.
4. The baseline (waiting room off) visibly degrades under the same load.
5. Audit log shows every step; integrity check passes, and fails if a row is edited.
6. OMNeT++ graphs show E1 to E3 with confidence intervals.

---

## 9. Build guide

### Architecture and folders
```
/app      src/{routes,controllers,services,middleware,db,queue,policies}  views/ public/
/db       migrations/ seed/
/loadtest autocannon-or-k6 scenarios, virtual-student generator
/radius   freeradius config (P2)
/sim      OMNeT++ project (ned, ini, cc, msg)
/docs     diagrams, api, screenshots
docker-compose.yml  .env.example  README.md
```
**Libraries:** express, helmet, express-rate-limit (Redis store), express-validator, bcrypt, jsonwebtoken, otplib, qrcode, nodemailer, pg + a migration tool (knex or node-pg-migrate), ioredis, a CSRF library, pino (logging), jest + supertest (tests).

**Node note:** `bcrypt` work runs on libuv's thread pool (size 4 by default). Under heavy load it is a real bottleneck, so test with `UV_THREADPOOL_SIZE` and with clustering. This is exactly the behavior your simulation models.

### Week-by-week (double-time plan: two parallel tracks)
| Week | Track 1: Backend | Track 2: Front end / Simulation |
|---|---|---|
| **1** | Docker compose (Postgres, Redis); migrations and seed; register, login, bcrypt, lockout, logs with hash chain; OTP and TOTP; password reset; roles. **Measure real login time.** | Basic UI (register, login, OTP, settings). Install OMNeT++/INET, run queueing sample, sketch the model. |
| **2** | JWT/cookie session, revocation; portal pages; waiting room (Redis); rate limiting; access windows; concurrent session limit; risk score and notifications | Waiting-room page, portal pages, admin dashboard (SSE), users/policies/logs screens. Build the OMNeT++ model using measured numbers. |
| **3** | Clustering/PM2 test; load-test scripts; rush-hour simulator; vouchers; step-up OTP; FreeRADIUS integration; security tests | Run E1 to E7 with repeated seeds; validate against load tests; capture screenshots and graphs; send first results to colleague. |
| **4** | Bug fixes, hardening, README/API docs, backups of data/demo | E8; polish UI; demo rehearsal; record a backup demo video; final graphs. |

**If you fall behind:** protect P0, then P1 items that feed the thesis (waiting room, E1 to E3, validation). P2 goes last.

### Demo script (about 8 minutes)
1. Explain the problem (rush-hour portal failure). 2. Register and log in with OTP, then open Fees, Hostel, Registration with no second login. 3. Wrong passwords, lockout, admin unlock. 4. Admin dashboard and policy change. 5. Run the rush-hour simulator with waiting room **off**, then **on**. 6. Show audit log and the integrity check. 7. Show OMNeT++ graphs and validation. 8. Show FreeRADIUS `radtest` accept/reject.

---

## 10. What to hand your colleague each week
- **Week 1:** ER diagram, screens, stack and versions, measured login time.
- **Week 2:** screenshots of every screen, architecture and sequence diagrams, simulation model description.
- **Week 3:** load-test results, OMNeT++ graphs, security test results.
- **Week 4:** final screenshots, FreeRADIUS evidence, limitations you actually hit.

---
*Verify library versions, FreeRADIUS configuration, OMNeT++/INET compatibility, and legal references against their official documentation before finalizing.*
