'use strict';

// Exactly one active policy row (id = 1). Change history (policy_history) arrives in Phase 3.
// Queue defaults are placeholders until Phase 5/8 measurements.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE policies (
      id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      min_length          smallint NOT NULL DEFAULT 8 CHECK (min_length BETWEEN 8 AND 72),
      require_upper       boolean  NOT NULL DEFAULT true,
      require_special     boolean  NOT NULL DEFAULT true,
      max_attempts        smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
      lockout_minutes     integer  NOT NULL DEFAULT 15 CHECK (lockout_minutes BETWEEN 1 AND 1440),
      session_timeout_min integer  NOT NULL DEFAULT 30 CHECK (session_timeout_min BETWEEN 1 AND 1440),
      require_2fa_admin   boolean  NOT NULL DEFAULT true,
      max_sessions        smallint NOT NULL DEFAULT 3 CHECK (max_sessions BETWEEN 1 AND 20),
      queue_capacity      integer  NOT NULL DEFAULT 200 CHECK (queue_capacity >= 1),
      queue_batch         integer  NOT NULL DEFAULT 50 CHECK (queue_batch >= 1),
      queue_interval_sec  integer  NOT NULL DEFAULT 5 CHECK (queue_interval_sec >= 1),
      updated_by          bigint REFERENCES users (id) ON DELETE SET NULL,
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw('INSERT INTO policies DEFAULT VALUES');
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE policies');
};
