'use strict';

const { getPolicy } = require('../policies/policyRepo');
const { checkPassword } = require('./passwordPolicy');
const { normalizeId, normalizeEmail, looksLikeEmail } = require('./identity');

const UNIQUE_VIOLATION = '23505';
const REJECTED = Object.freeze({ ok: false, kind: 'rejected' });

/**
 * Registration and login (FR-A1, A3 to A6).
 *
 * Lockout rules (FR-A6, FR-P5):
 *  - Only a wrong password for an existing, active, unlocked account counts.
 *    Validation errors, DB errors, bcrypt errors, and timeouts throw instead,
 *    so they never reach the counter.
 *  - While locked, the password is not checked and attempts neither count nor
 *    extend the lock (an attacker cannot keep an account locked forever).
 *  - After the lock expires the counter starts fresh; success resets it to 0.
 */
function createAuthService({ db, hasher, logger }) {
  const roleIds = new Map();

  async function roleId(name) {
    if (!roleIds.has(name)) {
      const row = await db('roles').where({ name }).first('id');
      if (!row) throw new Error(`role "${name}" is missing; run migrations`);
      roleIds.set(name, row.id);
    }
    return roleIds.get(name);
  }

  async function register({ matricNo, email, password }, { log = logger } = {}) {
    const policy = await getPolicy(db);
    const problems = checkPassword(password, policy);
    if (problems.length > 0) return { ok: false, kind: 'invalid', fields: { password: problems } };

    const id = normalizeId(matricNo);
    const mail = normalizeEmail(email);

    // Cheap checks first, so rejected sign-ups never spend a bcrypt hash.
    const record = await db('student_records').where({ matric_no: id }).first();
    if (!record) {
      log.info({ event: 'register_rejected', reason: 'not_in_records' }, 'registration rejected');
      return REJECTED;
    }
    const taken = await db('users').where({ matric_or_staff_id: id }).orWhere({ email: mail }).first('id');
    if (taken) {
      log.info({ event: 'register_rejected', reason: 'already_registered_or_email_taken' }, 'registration rejected');
      return REJECTED;
    }

    const passwordHash = await hasher.hash(password);
    try {
      const [row] = await db('users')
        .insert({
          matric_or_staff_id: id,
          username: id,
          email: mail,
          password_hash: passwordHash,
          role_id: await roleId('student'),
          level: record.level,
          faculty: record.faculty,
        })
        .returning('id');
      log.info({ event: 'register_success', userId: row.id }, 'student registered');
      return { ok: true, userId: row.id };
    } catch (err) {
      // A concurrent registration won the race for the same ID or email.
      if (err.code === UNIQUE_VIOLATION) {
        log.info({ event: 'register_rejected', reason: 'unique_violation' }, 'registration rejected');
        return REJECTED;
      }
      throw err;
    }
  }

  async function findForLogin(identifier) {
    const where = looksLikeEmail(identifier)
      ? { 'users.email': normalizeEmail(identifier) }
      : { 'users.matric_or_staff_id': normalizeId(identifier) };
    return db('users')
      .join('roles', 'roles.id', 'users.role_id')
      .where(where)
      .first(
        'users.id',
        'users.password_hash',
        'users.is_active',
        'roles.name as role',
        // Compare against the DB clock so app/DB clock skew cannot matter.
        db.raw('(users.locked_until IS NOT NULL AND users.locked_until > now()) AS is_locked'),
      );
  }

  /**
   * Count one credential failure atomically. Concurrent failures serialize on
   * the row lock; the WHERE clause re-checks the lock, so once an account is
   * locked, further concurrent failures are not counted.
   */
  async function recordFailure(userId, policy) {
    const { rows } = await db.raw(
      `UPDATE users SET
         failed_attempts = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END) >= ?::int
             THEN now() + make_interval(mins => ?::int)
           ELSE NULL
         END
       WHERE id = ? AND (locked_until IS NULL OR locked_until <= now())
       RETURNING failed_attempts, locked_until`,
      [policy.max_attempts, policy.lockout_minutes, userId],
    );
    return rows[0] || null;
  }

  async function login({ identifier, password }, { log = logger } = {}) {
    const policy = await getPolicy(db);
    const user = await findForLogin(identifier);

    // Same-cost dummy compare so these paths take as long as a real check.
    if (!user || !user.is_active || user.is_locked) {
      await hasher.compare(password, await hasher.dummyHash());
      const reason = !user ? 'unknown_user' : !user.is_active ? 'inactive' : 'locked';
      log.info({ event: 'login_failure', reason, userId: user ? user.id : undefined }, 'login failed');
      return { ok: false, reason, policy };
    }

    const matches = await hasher.compare(password, user.password_hash);
    if (!matches) {
      const result = await recordFailure(user.id, policy);
      const lockedNow = Boolean(result && result.locked_until);
      log.info(
        { event: 'login_failure', reason: 'bad_password', userId: user.id, failedAttempts: result && result.failed_attempts },
        'login failed',
      );
      if (lockedNow) {
        log.warn({ event: 'lockout', userId: user.id, lockedUntil: result.locked_until }, 'account locked');
      }
      return { ok: false, reason: 'bad_password', policy };
    }

    await db('users').where({ id: user.id }).update({
      failed_attempts: 0,
      locked_until: null,
      last_login: db.fn.now(),
    });
    log.info({ event: 'login_success', userId: user.id, role: user.role }, 'login succeeded');
    return { ok: true, user: { id: user.id, role: user.role } };
  }

  return { register, login };
}

module.exports = { createAuthService };
