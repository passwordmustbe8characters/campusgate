'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { connectDb, resetData, resetAndSeed, PASSWORDS } = require('./helpers');
const { testUrls } = require('./testEnv');
const { seedAll } = require('../../db/seed/lib/seedAll');
const { createHasher } = require('../../app/src/services/passwordHasher');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');

describe('seed (real PostgreSQL)', () => {
  let db;
  beforeAll(() => { db = connectDb(); });
  afterAll(() => db.destroy());

  test('default counts: 2,000 records, 1,500 registered + staff + admin, 500 free', async () => {
    const summary = await resetAndSeed(db, { registeredStudents: 1500, freeStudents: 500 });

    expect(summary).toMatchObject({ studentRecords: 2000, accountsCreated: 1502 });
    expect(Number((await db('student_records').count('* as n'))[0].n)).toBe(2000);
    const byRole = await db('users').join('roles', 'roles.id', 'users.role_id')
      .groupBy('roles.name').select('roles.name').count('* as n');
    expect(Object.fromEntries(byRole.map((r) => [r.name, Number(r.n)]))).toEqual({ student: 1500, staff: 1, admin: 1 });

    const free = await db('student_records')
      .leftJoin('users', 'users.matric_or_staff_id', 'student_records.matric_no')
      .whereNull('users.id').count('* as n');
    expect(Number(free[0].n)).toBe(500);
  });

  test('re-running is safe: nothing duplicated, nothing re-hashed', async () => {
    const before = await db('users').orderBy('id').select('id', 'password_hash');
    const summary = await seedAll(db, {
      registeredStudents: 1500, freeStudents: 500, bcryptCost: 4,
      studentPassword: PASSWORDS.student, staffPassword: PASSWORDS.staff, adminPassword: PASSWORDS.admin,
    });
    expect(summary).toMatchObject({ accountsCreated: 0, accountsAlreadyPresent: 1502 });
    expect(await db('users').orderBy('id').select('id', 'password_hash')).toEqual(before);
  });

  test('seeded passwords are bcrypt hashes at the requested cost, never plain text', async () => {
    const rows = await db('users').select('password_hash');
    expect(rows.every((r) => r.password_hash.startsWith('$2b$04$'))).toBe(true);
    expect(rows.some((r) => Object.values(PASSWORDS).includes(r.password_hash))).toBe(false);
    const sample = await db('users').where({ matric_or_staff_id: 'ADMIN0001' }).first();
    await expect(createHasher(4).compare(PASSWORDS.admin, sample.password_hash)).resolves.toBe(true);
  });

  test('seed passwords that fail the password policy are refused', async () => {
    await expect(seedAll(db, {
      registeredStudents: 1, freeStudents: 0, bcryptCost: 4,
      studentPassword: 'password123', staffPassword: PASSWORDS.staff, adminPassword: PASSWORDS.admin,
    })).rejects.toThrow(/studentPassword fails the password policy/);
  });

  test('`npm run seed` (knex seed:run) honours SEED_REGISTERED_STUDENTS / SEED_FREE_STUDENTS', async () => {
    await resetData(db);
    const { stdout } = await run(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'knex', 'bin', 'cli.js'), 'seed:run', '--knexfile', path.join(ROOT, 'knexfile.js')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: testUrls().databaseUrl,
          BCRYPT_COST: '4',
          SEED_REGISTERED_STUDENTS: '20',
          SEED_FREE_STUDENTS: '5',
          SEED_STUDENT_PASSWORD: PASSWORDS.student,
          SEED_STAFF_PASSWORD: PASSWORDS.staff,
          SEED_ADMIN_PASSWORD: PASSWORDS.admin,
        },
      },
    );
    expect(stdout).toMatch(/Seeding 20 registered \+ 5 free students/);
    expect(Number((await db('student_records').count('* as n'))[0].n)).toBe(25);
    expect(Number((await db('users').count('* as n'))[0].n)).toBe(22);
  });
});
