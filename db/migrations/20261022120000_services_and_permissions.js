'use strict';

// Phase 3 (FR-Z1): services and the role-to-service permission table.
// Seed mapping approved by the developer (2026-10-22):
//   student -> fees, hostel, course_registration
//   staff   -> fees, hostel, course_registration (staff-specific services: future work)
//   admin   -> admin_console only
//   guest   -> nothing until vouchers (Phase 7)
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE services (
      id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      key        text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
      name       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`
    INSERT INTO services (key, name) VALUES
      ('fees', 'Fees'),
      ('hostel', 'Hostel'),
      ('course_registration', 'Course Registration'),
      ('admin_console', 'Admin console')
  `);

  await knex.raw(`
    CREATE TABLE role_permissions (
      role_id    smallint NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
      service_id smallint NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      granted_by bigint REFERENCES users (id) ON DELETE SET NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (role_id, service_id)
    )
  `);
  await knex.raw(`
    INSERT INTO role_permissions (role_id, service_id)
    SELECT r.id, s.id
    FROM roles r JOIN services s ON
         (r.name IN ('student', 'staff') AND s.key IN ('fees', 'hostel', 'course_registration'))
      OR (r.name = 'admin' AND s.key = 'admin_console')
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE role_permissions');
  await knex.raw('DROP TABLE services');
};
