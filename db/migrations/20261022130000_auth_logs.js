'use strict';

// Phase 3 (FR-L1, FR-L3): append-only, tamper-evident audit log.
//
// seq       gap-free position in the chain, assigned by the (single) writer under
//           an advisory lock; the chain is verified in seq order.
// event_id  unique id given to the event when it happened; makes writing
//           idempotent (a re-delivered event is skipped, never duplicated).
// row_hash  HMAC-SHA256(AUDIT_HMAC_KEY, prev_hash + canonical row). The key is
//           never stored in the database.
//
// Append-only: triggers reject UPDATE, DELETE and TRUNCATE. The table owner can
// still disable them (ALTER TABLE ... DISABLE TRIGGER); a limited app database
// role without that right is a Phase 9 item. The hash chain is what detects
// changes made that way.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE auth_logs (
      seq          bigint PRIMARY KEY CHECK (seq > 0),
      event_id     uuid NOT NULL UNIQUE,
      occurred_at  timestamptz NOT NULL,
      recorded_at  timestamptz NOT NULL DEFAULT now(),
      event_type   text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*$'),
      user_id      bigint,               -- no FK: the record must outlive the account
      subject_hash text,                 -- keyed hash of the identifier typed (failed logins, resets)
      ip           text,
      user_agent   text CHECK (char_length(user_agent) <= 256),
      success      boolean NOT NULL,
      details      jsonb NOT NULL DEFAULT '{}'::jsonb,
      prev_hash    text NOT NULL,
      row_hash     text NOT NULL
    )
  `);
  await knex.raw('CREATE INDEX auth_logs_occurred_idx ON auth_logs (occurred_at)');
  await knex.raw('CREATE INDEX auth_logs_user_idx ON auth_logs (user_id, occurred_at) WHERE user_id IS NOT NULL');
  await knex.raw('CREATE INDEX auth_logs_type_idx ON auth_logs (event_type, occurred_at)');

  await knex.raw(`
    CREATE FUNCTION auth_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'auth_logs is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
    END $$
  `);
  await knex.raw(`
    CREATE TRIGGER auth_logs_no_update_delete BEFORE UPDATE OR DELETE ON auth_logs
      FOR EACH ROW EXECUTE FUNCTION auth_logs_append_only()
  `);
  await knex.raw(`
    CREATE TRIGGER auth_logs_no_truncate BEFORE TRUNCATE ON auth_logs
      FOR EACH STATEMENT EXECUTE FUNCTION auth_logs_append_only()
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE auth_logs');
  await knex.raw('DROP FUNCTION auth_logs_append_only()');
};
