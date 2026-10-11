'use strict';

// Roles are reference data the app cannot run without, so the migration inserts them.
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE roles (
      id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`INSERT INTO roles (name) VALUES ('student'), ('staff'), ('guest'), ('admin')`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE roles');
};
