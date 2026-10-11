'use strict';

// The seeded "registry" that student sign-ups are validated against (FR-A1).
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE student_records (
      matric_no  text PRIMARY KEY
                 CHECK (matric_no = upper(btrim(matric_no)) AND matric_no <> ''),
      name       text NOT NULL,
      level      smallint NOT NULL CHECK (level IN (100, 200, 300, 400, 500, 600)),
      faculty    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE student_records');
};
