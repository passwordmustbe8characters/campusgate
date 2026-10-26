'use strict';

// Phase 4 (FR-L2, FR-P1, FR-P6): one row per issued session token.
// The token itself (a signed JWT) is never stored; `jti` identifies it.
// End of a session = revoked_at, or expires_at if it was never revoked.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE sessions (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      jti           uuid NOT NULL UNIQUE,
      scope         text NOT NULL CHECK (scope IN ('full', 'enrol')),  -- 'enrol': admin without TOTP (FR-A13)
      ip            text,
      user_agent    text CHECK (char_length(user_agent) <= 256),
      created_at    timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      revoked_at    timestamptz,
      revoke_reason text CHECK (revoke_reason ~ '^[a-z][a-z0-9_]*$'),
      CHECK (expires_at > created_at),
      CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
    )
  `);
  // "Sign out everywhere" and revocations look up a user's live sessions.
  await knex.raw('CREATE INDEX sessions_user_open_idx ON sessions (user_id) WHERE revoked_at IS NULL');
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE sessions');
};
