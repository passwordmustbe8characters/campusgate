'use strict';

const bcrypt = require('bcrypt');
const { checkPassword } = require('../../../app/src/services/passwordPolicy');
const { generateStudents, studentEmail } = require('./studentData');

const CHUNK = 500;
const HASH_BATCH = 100;

async function roleIds(knex) {
  const rows = await knex('roles').select('id', 'name');
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

async function insertIgnoringExisting(knex, table, rows, conflictColumn) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await knex(table).insert(rows.slice(i, i + CHUNK)).onConflict(conflictColumn).ignore();
  }
}

/**
 * Hash at the real cost, in parallel batches. bcrypt's async API runs on
 * libuv's thread pool, so a batch keeps every pool thread busy.
 */
async function hashAll(passwords, cost) {
  const hashes = [];
  for (let i = 0; i < passwords.length; i += HASH_BATCH) {
    const batch = passwords.slice(i, i + HASH_BATCH).map((p) => bcrypt.hash(p, cost));
    hashes.push(...(await Promise.all(batch)));
  }
  return hashes;
}

/**
 * Seed the registry and accounts. Safe to run repeatedly: existing rows are
 * kept (passwords of existing accounts are NOT reset).
 *
 * The first `registeredStudents` records get accounts (for load tests);
 * the next `freeStudents` records stay free for the live registration demo.
 */
async function seedAll(knex, options) {
  const {
    registeredStudents,
    freeStudents,
    studentPassword,
    staffPassword,
    adminPassword,
    bcryptCost,
    log = () => {},
  } = options;

  const defaultPolicy = await knex('policies').where({ id: 1 }).first();
  if (!defaultPolicy) throw new Error('policies row id=1 is missing; run "npm run migrate" first');
  for (const [name, password] of Object.entries({ studentPassword, staffPassword, adminPassword })) {
    const problems = checkPassword(password, defaultPolicy);
    if (problems.length > 0) throw new Error(`Seed ${name} fails the password policy: ${problems.join(' ')}`);
  }

  const started = Date.now();
  const roles = await roleIds(knex);
  const students = generateStudents(registeredStudents + freeStudents);
  await insertIgnoringExisting(knex, 'student_records', students, 'matric_no');

  // Only hash accounts that do not exist yet, so re-runs are fast.
  const wanted = [
    ...students.slice(0, registeredStudents).map((s, i) => ({
      matric_or_staff_id: s.matric_no,
      email: studentEmail(s, i),
      role_id: roles.student,
      level: s.level,
      faculty: s.faculty,
      password: studentPassword,
    })),
    { matric_or_staff_id: 'STAFF0001', email: 'staff@campusgate.test', role_id: roles.staff, password: staffPassword },
    { matric_or_staff_id: 'ADMIN0001', email: 'admin@campusgate.test', role_id: roles.admin, password: adminPassword },
  ];
  const existing = new Set(
    (await knex('users').select('matric_or_staff_id')).map((r) => r.matric_or_staff_id),
  );
  const missing = wanted.filter((u) => !existing.has(u.matric_or_staff_id));

  const hashStarted = Date.now();
  const hashes = await hashAll(missing.map((u) => u.password), bcryptCost);
  const hashMs = Date.now() - hashStarted;

  const rows = missing.map(({ password, ...user }, i) => ({
    ...user,
    username: user.matric_or_staff_id,
    password_hash: hashes[i],
  }));
  await insertIgnoringExisting(knex, 'users', rows, 'matric_or_staff_id');

  const summary = {
    studentRecords: students.length,
    registeredStudents,
    freeStudents,
    accountsCreated: rows.length,
    accountsAlreadyPresent: wanted.length - rows.length,
    bcryptCost,
    hashMs,
    totalMs: Date.now() - started,
  };
  log(summary);
  return summary;
}

module.exports = { seedAll };
