'use strict';

// Phase 7 (FR-A2): email verification link before a new account can sign in.
// Same shape as password_reset_tokens: only an HMAC of the token is stored.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE email_verifications (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used       boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw('CREATE INDEX email_verifications_user_idx ON email_verifications (user_id) WHERE used = false');
  // Accounts that existed before verification was introduced (the seeded demo
  // accounts) are treated as verified; only new sign-ups must click the link.
  await knex.raw('UPDATE users SET email_verified = true WHERE email_verified = false');
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE email_verifications');
};
