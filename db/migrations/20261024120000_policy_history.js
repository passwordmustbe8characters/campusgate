'use strict';

// Phase 3 (FR-Z5): history of admin changes to policies, roles and permissions.
// One table for all three ("subject"), old and new values as JSON, who and when.
// Written in the same transaction as the change and its audit event.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE policy_history (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      subject        text NOT NULL CHECK (subject IN ('policy', 'user_role', 'role_permission')),
      subject_id     text NOT NULL,          -- policy id, user id, or "role:service"
      old_value      jsonb,
      new_value      jsonb,
      changed_fields text[] NOT NULL DEFAULT '{}',
      actor          text NOT NULL,          -- 'cli' now; an admin user id from the console (Phase 6)
      changed_by     bigint REFERENCES users (id) ON DELETE SET NULL,
      changed_at     timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw('CREATE INDEX policy_history_subject_idx ON policy_history (subject, changed_at)');
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE policy_history');
};
