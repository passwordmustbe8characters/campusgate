'use strict';

const { connectDb } = require('./helpers');

const TABLES = [
  'otp_codes', 'password_reset_tokens', 'policies', 'role_permissions', 'roles', 'services', 'student_records',
  'totp_backup_codes', 'users',
];

async function tables(db) {
  const { rows } = await db.raw(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name NOT LIKE 'knex_%' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe('migrations (real PostgreSQL)', () => {
  let db;
  beforeAll(() => { db = connectDb(); });
  afterAll(async () => {
    await db.migrate.latest(); // leave the schema in place for the other suites
    await db.destroy();
  });

  test('run down completely and up again', async () => {
    expect(await tables(db)).toEqual(TABLES);
    await db.migrate.rollback(undefined, true);
    expect(await tables(db)).toEqual([]);
    await db.migrate.latest();
    expect(await tables(db)).toEqual(TABLES);
  });

  test('seed the four roles and one default policy row', async () => {
    expect((await db('roles').orderBy('id')).map((r) => r.name)).toEqual(['student', 'staff', 'guest', 'admin']);
    const policies = await db('policies');
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      id: 1, min_length: 8, require_upper: true, require_special: true, max_attempts: 5, lockout_minutes: 15,
    });
  });

  describe('constraints reject bad data even if the app is bypassed', () => {
    const base = { name: 'Test Student', level: 100, faculty: 'Science' };

    test('only one policy row can exist', async () => {
      await expect(db('policies').insert({ id: 2 })).rejects.toThrow(/check constraint/);
    });

    test('policy values are range-checked', async () => {
      await expect(db('policies').where({ id: 1 }).update({ max_attempts: 0 })).rejects.toThrow(/check constraint/);
      await expect(db('policies').where({ id: 1 }).update({ min_length: 4 })).rejects.toThrow(/check constraint/);
    });

    test('matric numbers must be stored normalized', async () => {
      await expect(db('student_records').insert({ ...base, matric_no: 'sci/2025/9999' })).rejects.toThrow(/check constraint/);
      await expect(db('student_records').insert({ ...base, matric_no: ' SCI/2025/9999' })).rejects.toThrow(/check constraint/);
    });

    test('levels outside 100-600 are rejected', async () => {
      await expect(db('student_records').insert({ ...base, matric_no: 'SCI/2025/9998', level: 700 })).rejects.toThrow(/check constraint/);
    });

    test('emails must be lower-case and unique; failed_attempts cannot go negative', async () => {
      const user = {
        matric_or_staff_id: 'MIGTEST1', username: 'MIGTEST1', email: 'mig@campusgate.test',
        password_hash: 'x', role_id: 1,
      };
      await expect(db('users').insert({ ...user, email: 'Mig@Campusgate.test' })).rejects.toThrow(/check constraint/);
      await db('users').insert(user);
      await expect(db('users').insert({ ...user, matric_or_staff_id: 'MIGTEST2', username: 'MIGTEST2' }))
        .rejects.toThrow(/unique constraint/);
      await expect(db('users').where({ email: user.email }).update({ failed_attempts: -1 })).rejects.toThrow(/check constraint/);
      await db('users').where({ email: user.email }).del();
    });

    test('FR-A13: require_2fa_admin cannot be switched off', async () => {
      await expect(db('policies').where({ id: 1 }).update({ require_2fa_admin: false }))
        .rejects.toThrow(/policies_admin_2fa_always/);
    });

    test('2FA flag, method and TOTP secret must agree', async () => {
      const user = {
        matric_or_staff_id: 'MIGTEST3', username: 'MIGTEST3', email: 'mig3@campusgate.test', password_hash: 'x', role_id: 1,
      };
      await expect(db('users').insert({ ...user, two_factor_enabled: true }))
        .rejects.toThrow(/users_2fa_method_matches_flag/);
      await expect(db('users').insert({ ...user, two_factor_method: 'email' }))
        .rejects.toThrow(/users_2fa_method_matches_flag/);
      await expect(db('users').insert({ ...user, two_factor_enabled: true, two_factor_method: 'totp' }))
        .rejects.toThrow(/users_totp_needs_secret/);
      await expect(db('users').insert({ ...user, two_factor_enabled: true, two_factor_method: 'sms' }))
        .rejects.toThrow(/check constraint/);
    });

    test('OTP attempts are capped at 3 by the database too', async () => {
      const [u] = await db('users').insert({
        matric_or_staff_id: 'MIGTEST4', username: 'MIGTEST4', email: 'mig4@campusgate.test', password_hash: 'x', role_id: 1,
      }).returning('id');
      const row = { user_id: u.id, code_hash: 'h', channel: 'email', expires_at: db.fn.now() };
      await expect(db('otp_codes').insert({ ...row, attempts_used: 4 })).rejects.toThrow(/check constraint/);
      await expect(db('otp_codes').insert({ ...row, channel: 'carrier-pigeon' })).rejects.toThrow(/check constraint/);
      await db('users').where({ id: u.id }).del();
    });
  });
});
