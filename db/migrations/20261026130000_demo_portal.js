'use strict';

// Phase 4 (FR-M1): DEMONSTRATION content for the mock portal pages. None of
// this is real University data: fee amounts, halls and courses are invented,
// and invoices carry no bank details (no payment is possible).
const LEVELS = [100, 200, 300, 400, 500];

const FEES = (level) => [
  ['Tuition (demo)', 45000 + (level - 100) * 25],
  ...(level === 100 ? [['Acceptance fee (demo)', 20000]] : []),
  ['ICT levy (demo)', 5000],
  ['Medical services (demo)', 3000],
  ['Examination fee (demo)', 4000],
  ['Hostel maintenance (demo)', 7500],
  ...(level === 500 ? [['Final-year project fee (demo)', 10000]] : []),
];

const COURSES = {
  100: [['GST 101', 'Use of English I', 2], ['GST 103', 'Nigerian Peoples and Culture', 2], ['MTH 101', 'Elementary Mathematics I', 3], ['PHY 101', 'General Physics I', 3], ['CSC 101', 'Introduction to Computing', 3]],
  200: [['GST 201', 'Philosophy and Logic', 2], ['GEN 201', 'Core course A (demo)', 3], ['GEN 203', 'Core course B (demo)', 3], ['GEN 205', 'Elective A (demo)', 2]],
  300: [['GEN 301', 'Core course C (demo)', 3], ['GEN 303', 'Core course D (demo)', 3], ['GEN 305', 'Research methods (demo)', 2], ['GEN 399', 'Industrial training (demo)', 6]],
  400: [['GEN 401', 'Core course E (demo)', 3], ['GEN 403', 'Core course F (demo)', 3], ['GEN 405', 'Elective B (demo)', 2]],
  500: [['GEN 501', 'Core course G (demo)', 3], ['GEN 503', 'Seminar (demo)', 2], ['GEN 599', 'Final-year project (demo)', 6]],
};

const HALLS = [['Hall A (demo)', 42, 400], ['Hall B (demo)', 0, 350], ['Hall C (demo)', 118, 500], ['Hall D (demo)', 7, 250], ['Hall E (demo)', 63, 300]];

exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE demo_fees (
      id           smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      level        smallint NOT NULL CHECK (level IN (100, 200, 300, 400, 500, 600)),
      item         text NOT NULL,
      amount_naira integer NOT NULL CHECK (amount_naira > 0),
      UNIQUE (level, item)
    )`);
  await knex.raw(`
    CREATE TABLE demo_courses (
      level smallint NOT NULL CHECK (level IN (100, 200, 300, 400, 500, 600)),
      code  text NOT NULL,
      title text NOT NULL,
      units smallint NOT NULL CHECK (units BETWEEN 1 AND 12),
      PRIMARY KEY (level, code)
    )`);
  await knex.raw(`
    CREATE TABLE demo_hostels (
      hall       text PRIMARY KEY,
      beds_free  integer NOT NULL CHECK (beds_free >= 0),
      beds_total integer NOT NULL CHECK (beds_total >= beds_free)
    )`);
  await knex.raw(`
    CREATE TABLE demo_invoices (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      reference   text NOT NULL UNIQUE CHECK (reference ~ '^CG-[0-9]{4}-[2-9A-HJKMNP-Z]{8}$'),
      total_naira integer NOT NULL CHECK (total_naira >= 0),
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);

  await knex('demo_fees').insert(LEVELS.flatMap((level) => FEES(level).map(([item, amount]) => ({ level, item, amount_naira: amount }))));
  await knex('demo_courses').insert(LEVELS.flatMap((level) => COURSES[level].map(([code, title, units]) => ({ level, code, title, units }))));
  await knex('demo_hostels').insert(HALLS.map(([hall, free, total]) => ({ hall, beds_free: free, beds_total: total })));
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE demo_invoices, demo_hostels, demo_courses, demo_fees');
};
