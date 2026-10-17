'use strict';

// Phase 2: second factors and recovery (FR-A7 to A10, A13).
// Columns marked "beyond SPEC §5" were approved in the Phase 2 plan.
exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN two_factor_method text CHECK (two_factor_method IN ('email', 'totp')),  -- beyond SPEC §5
      ADD COLUMN totp_last_step    bigint,                                               -- beyond SPEC §5: TOTP replay block
      ADD CONSTRAINT users_2fa_method_matches_flag
        CHECK (two_factor_enabled = (two_factor_method IS NOT NULL)),
      ADD CONSTRAINT users_totp_needs_secret
        CHECK (two_factor_method IS DISTINCT FROM 'totp' OR totp_secret_enc IS NOT NULL)
  `);

  // FR-A13 applies regardless of this flag; the column is pinned to true and not exposed as a toggle.
  await knex.raw('ALTER TABLE policies ADD CONSTRAINT policies_admin_2fa_always CHECK (require_2fa_admin = true)');

  await knex.raw(`
    CREATE TABLE otp_codes (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      code_hash     text NOT NULL,
      channel       text NOT NULL CHECK (channel IN ('console', 'email', 'sms-mock')),
      expires_at    timestamptz NOT NULL,
      attempts_used smallint NOT NULL DEFAULT 0 CHECK (attempts_used BETWEEN 0 AND 3),
      used          boolean NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now()  -- beyond SPEC §5
    )
  `);
  await knex.raw('CREATE INDEX otp_codes_open_idx ON otp_codes (user_id) WHERE used = false');

  await knex.raw(`
    CREATE TABLE totp_backup_codes (
      id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      used      boolean NOT NULL DEFAULT false,
      UNIQUE (user_id, code_hash)
    )
  `);

  await knex.raw(`
    CREATE TABLE password_reset_tokens (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used       boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()  -- beyond SPEC §5
    )
  `);
  await knex.raw('CREATE INDEX password_reset_tokens_open_idx ON password_reset_tokens (user_id) WHERE used = false');
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE password_reset_tokens');
  await knex.raw('DROP TABLE totp_backup_codes');
  await knex.raw('DROP TABLE otp_codes');
  await knex.raw('ALTER TABLE policies DROP CONSTRAINT policies_admin_2fa_always');
  await knex.raw(`
    ALTER TABLE users
      DROP CONSTRAINT users_totp_needs_secret,
      DROP CONSTRAINT users_2fa_method_matches_flag,
      DROP COLUMN totp_last_step,
      DROP COLUMN two_factor_method
  `);
};
