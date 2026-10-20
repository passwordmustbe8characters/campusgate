# Sign-in sequence (as built, end of Phase 2)

Password step, pre-auth ticket, and second factor. Every `POST` also carries a CSRF token (header) matching the visitor's pre-session cookie; a missing or wrong token is rejected with 403 before any of this runs.

## 1. Password step (`POST /auth/login`)

```mermaid
sequenceDiagram
    autonumber
    actor S as Student (browser)
    participant A as App (Express)
    participant P as PostgreSQL
    participant R as Redis
    participant M as Mail (SMTP / Mailpit)

    S->>A: GET /login
    A-->>S: page + CSRF token, pre-session and CSRF cookies
    S->>A: POST /auth/login {identifier, password} + X-CSRF-Token
    A->>P: read policy row (id = 1)
    A->>P: find user by matric/staff ID or email (+ is_locked from DB clock)

    alt unknown, inactive or locked account
        A->>A: bcrypt compare against same-cost dummy hash (equal work)
        A-->>S: 401 generic "Invalid ID or password..."
    else password wrong
        A->>A: bcrypt compare (cost 10)
        A->>P: atomic UPDATE: failed_attempts + 1, lock at max_attempts
        A-->>S: 401 (same generic message)
    else admin without TOTP (FR-A13)
        A->>R: issue enrolment-only account ticket (10 min)
        A-->>S: 200 {status: enrolment_required}  -> may only enrol TOTP
    else password correct, no 2FA
        A->>P: reset failed_attempts, set last_login
        A->>R: issue account ticket (10 min, interim until Phase 4)
        A-->>S: 200 {status: signed_in}
    else password correct, 2FA on (counter NOT reset yet)
        A->>R: issue pre-auth ticket (256-bit; Redis stores only its HMAC; 5 min; 5 attempts)
        opt method = email
            A->>R: SET cooldown NX EX 60
            A->>P: cancel open codes, insert HMAC(code), expires +5 min
            A->>M: send 6-digit code (timeout; failure = not counted, user can Resend)
        end
        A-->>S: 200 {status: second_factor_required, method} + pre-auth cookie
    end
```

## 2. Second factor (`POST /auth/otp` or `POST /auth/totp/verify`)

```mermaid
sequenceDiagram
    autonumber
    actor S as Student (browser)
    participant A as App (Express)
    participant R as Redis
    participant P as PostgreSQL

    S->>A: POST /auth/otp {code}  or  /auth/totp/verify {code | backupCode}
    A->>R: read pre-auth ticket; check the method is allowed
    A->>R: Lua: attempts + 1 (over the limit deletes the ticket)
    alt ticket missing, expired or used up / account locked or inactive
        A-->>S: 401 "Your sign-in has expired" (restart: true), not counted
    else ticket valid
        A->>P: load account (active? locked? 2FA method, secret)
        alt email code
            A->>P: atomic UPDATE attempts_used + 1 WHERE < 3 AND unexpired, RETURNING hash
            A->>A: constant-time compare of HMAC
        else authenticator code
            A->>A: decrypt secret (AES-256-GCM, TOTP_ENC_KEY); verify +/- 1 step, after last used step
            A->>P: atomic UPDATE totp_last_step (replay guard)
        else backup code
            A->>P: atomic UPDATE used = true WHERE hash matches AND unused
        end
        alt code correct
            A->>R: Lua: read and delete ticket (single use)
            A->>P: reset failed_attempts, set last_login
            A->>R: issue account ticket
            A-->>S: 200 {status: signed_in}
        else code wrong or replayed
            A->>P: atomic UPDATE failed_attempts + 1 (same counter as passwords)
            A-->>S: 401 "Invalid or expired code."
        else no usable code (expired, 3 attempts used)
            A-->>S: 401 "Invalid or expired code." (not counted)
        end
    end
```

**What never counts toward lockout (FR-P5):** delivery failures and timeouts, Redis or database outages (503), expired or used-up codes, a changed `TOTP_ENC_KEY` (500), invalid input (400), a missing CSRF token (403), and an expired ticket.

**Phase 4 will change:** the account ticket is replaced by the JWT session cookie, and a password reset or change will also revoke sessions.
