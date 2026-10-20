# Data model (as built, end of Phase 2)

PostgreSQL tables created by the migrations in `db/migrations/`. Columns marked *(beyond SPEC §5)* were added during the build and approved in the phase plans. Redis keys are listed after the diagram (they are not tables).

```mermaid
erDiagram
    ROLES ||--o{ USERS : "has"
    USERS ||--o{ OTP_CODES : "receives"
    USERS ||--o{ TOTP_BACKUP_CODES : "owns"
    USERS ||--o{ PASSWORD_RESET_TOKENS : "requests"
    USERS |o--o{ POLICIES : "updated_by"
    STUDENT_RECORDS ||--o| USERS : "validates sign-up (matric_no = matric_or_staff_id, checked by the app)"

    ROLES {
        smallint id PK
        text name UK "student | staff | guest | admin"
        timestamptz created_at
    }

    STUDENT_RECORDS {
        text matric_no PK "stored upper-case, e.g. SCI/2022/0001"
        text name
        smallint level "100-600"
        text faculty
        timestamptz created_at
    }

    USERS {
        bigint id PK
        text matric_or_staff_id UK "upper-case"
        text username UK "= matric_or_staff_id"
        text email UK "lower-case"
        boolean email_verified "enforced in Phase 7"
        text password_hash "bcrypt, cost 10"
        smallint role_id FK
        smallint level "copied from student_records"
        text faculty "copied from student_records"
        boolean is_active
        boolean two_factor_enabled
        text two_factor_method "email | totp (beyond SPEC 5)"
        text totp_secret_enc "AES-256-GCM, bound to user id"
        bigint totp_last_step "TOTP replay guard (beyond SPEC 5)"
        integer failed_attempts
        timestamptz locked_until
        timestamptz last_login
        timestamptz created_at
    }

    POLICIES {
        smallint id PK "always 1 (CHECK)"
        smallint min_length
        boolean require_upper
        boolean require_special
        smallint max_attempts
        integer lockout_minutes
        integer session_timeout_min "used from Phase 4"
        boolean require_2fa_admin "pinned true (CHECK)"
        smallint max_sessions "used from Phase 7"
        integer queue_capacity "used from Phase 5"
        integer queue_batch "used from Phase 5"
        integer queue_interval_sec "used from Phase 5"
        bigint updated_by FK
        timestamptz updated_at
    }

    OTP_CODES {
        bigint id PK
        bigint user_id FK
        text code_hash "HMAC-SHA256, never the code"
        text channel "console | email | sms-mock"
        timestamptz expires_at "created + 5 min"
        smallint attempts_used "0-3 (CHECK)"
        boolean used
        timestamptz created_at "beyond SPEC 5"
    }

    TOTP_BACKUP_CODES {
        bigint id PK
        bigint user_id FK
        text code_hash "HMAC-SHA256; UNIQUE with user_id"
        boolean used
    }

    PASSWORD_RESET_TOKENS {
        bigint id PK
        bigint user_id FK
        text token_hash UK "HMAC-SHA256, never the token"
        timestamptz expires_at "created + 30 min"
        boolean used
        timestamptz created_at "beyond SPEC 5"
    }
```

**Constraints worth mentioning in the report**
- `users`: `two_factor_enabled` is true exactly when `two_factor_method` is set; `two_factor_method = 'totp'` requires `totp_secret_enc`; `failed_attempts >= 0`; IDs and emails must be stored normalized.
- `policies`: a single row (`id = 1`); `require_2fa_admin` cannot be false (FR-A13); value ranges are checked.
- Child tables (`otp_codes`, `totp_backup_codes`, `password_reset_tokens`) are deleted with their user (`ON DELETE CASCADE`).

**Redis keys (shared by all app processes)**

| Key | Holds | Lifetime |
|---|---|---|
| `cg:preauth:<HMAC of ticket>` | pre-auth ticket: user id, method, attempts | 5 min |
| `cg:acct:<HMAC of ticket>` | interim account ticket: user id, role, scope (removed in Phase 4) | 10 min |
| `cg:preauth:user:<id>`, `cg:acct:user:<id>` | index of a user's tickets, for revocation | same as tickets |
| `cg:totp-pending:<user id>` | TOTP secret during enrolment, encrypted | 10 min |
| `cg:cooldown:otp:<purpose>:<user id>` | OTP resend cooldown | 60 s |
| `cg:cooldown:reset:<HMAC of email>` | reset-email cooldown | 60 s |
| `cg:metrics:*` | counters (reset emails sent/failed, notification failures) | permanent |
| `cg:sms-mock:outbox` | sms-mock messages (development only) | last 200 |

Planned in later phases (not built yet): `services`, `role_permissions`, `policy_history`, `auth_logs` (Phase 3); `sessions` (Phase 4); `access_windows`, `guest_vouchers`, `email_verifications` (Phase 7).
