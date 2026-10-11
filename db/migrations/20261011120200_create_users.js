'use strict';

// All columns from SPEC section 5. The 2FA columns are unused until Phase 2.
// IDs and emails are stored normalized (upper-case ID, lower-case email); the
// CHECK constraints make the database reject anything that bypassed the app.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE users (
      id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      matric_or_staff_id text NOT NULL UNIQUE
                         CHECK (matric_or_staff_id = upper(btrim(matric_or_staff_id))
                                AND matric_or_staff_id <> ''),
      username           text NOT NULL UNIQUE,
      email              text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email <> ''),
      email_verified     boolean NOT NULL DEFAULT false,
      password_hash      text NOT NULL,
      role_id            smallint NOT NULL REFERENCES roles (id),
      level              smallint CHECK (level IN (100, 200, 300, 400, 500, 600)),
      faculty            text,
      is_active          boolean NOT NULL DEFAULT true,
      two_factor_enabled boolean NOT NULL DEFAULT false,
      totp_secret_enc    text,
      failed_attempts    integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      locked_until       timestamptz,
      last_login         timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`
    CREATE INDEX users_locked_until_idx ON users (locked_until) WHERE locked_until IS NOT NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE users');
};
