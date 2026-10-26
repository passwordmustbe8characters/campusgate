'use strict';

// Phase 7 (FR-Z2, FR-Z4, FR-D4).
// access_windows: while a service has windows today, each level/faculty may use
//   it only in its own window; after the day's last window closes it is open to
//   everyone (catch-up). No windows today = open as usual. Times are Lagos time.
// guest_vouchers: a one-time code an admin gives a visitor; only its HMAC is
//   stored. Each voucher has its own guest account (cannot sign in by password).
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE access_windows (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      service_id  smallint NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      level       smallint CHECK (level IN (100, 200, 300, 400, 500, 600)),  -- NULL = every level
      faculty     text,                                                       -- NULL = every faculty
      on_date     date,                                                       -- NULL = every day
      start_time  time NOT NULL,
      end_time    time NOT NULL,
      created_by  bigint REFERENCES users (id) ON DELETE SET NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CHECK (end_time > start_time)
    )
  `);
  await knex.raw(`
    CREATE TABLE guest_vouchers (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code_hash     text NOT NULL UNIQUE,
      guest_user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      services      text[] NOT NULL CHECK (cardinality(services) >= 1),
      label         text CHECK (char_length(label) <= 80),
      expires_at    timestamptz NOT NULL,
      used_at       timestamptz,
      revoked_at    timestamptz,
      created_by    bigint REFERENCES users (id) ON DELETE SET NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CHECK (expires_at > created_at)
    )
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE guest_vouchers, access_windows');
};
