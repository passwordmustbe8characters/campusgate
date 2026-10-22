'use strict';

const { getPolicy } = require('../policies/policyRepo');
const { checkPassword } = require('./passwordPolicy');
const { normalizeId, normalizeEmail, looksLikeEmail } = require('./identity');
const { recordFailure, completeLogin, noteFailure } = require('./accountState');

const UNIQUE_VIOLATION = '23505';
const REJECTED = Object.freeze({ ok: false, kind: 'rejected' });

/**
 * Registration and login (FR-A1, A3 to A6), with audit events (FR-L1).
 *
 * Lockout rules (FR-A6, FR-P5):
 *  - Only a wrong password for an existing, active, unlocked account counts.
 *    Validation errors, DB errors, bcrypt errors, and timeouts throw instead,
 *    so they never reach the counter.
 *  - While locked, the password is not checked and attempts neither count nor
 *    extend the lock (an attacker cannot keep an account locked forever).
 *  - After the lock expires the counter starts fresh; success resets it to 0.
 *
 * ctx = { log, ip, userAgent } (see auditContext); audit events here fail open.
 */
function createAuthService({ db, hasher, logger, audit }) {
  const roleIds = new Map();

  async function roleId(name) {
    if (!roleIds.has(name)) {
      const row = await db('roles').where({ name }).first('id');
      if (!row) throw new Error(`role "${name}" is missing; run migrations`);
      roleIds.set(name, row.id);
    }
    return roleIds.get(name);
  }

  async function rejectRegistration(reason, matricNo, ctx) {
    ctx.log.info({ event: 'register_rejected', reason }, 'registration rejected');
    await audit.record('register', { subject: matricNo, success: false, details: { reason } }, ctx);
    return REJECTED;
  }

  async function register({ matricNo, email, password }, ctx = { log: logger }) {
    const policy = await getPolicy(db);
    const problems = checkPassword(password, policy);
    if (problems.length > 0) return { ok: false, kind: 'invalid', fields: { password: problems } };

    const id = normalizeId(matricNo);
    const mail = normalizeEmail(email);

    // Cheap checks first, so rejected sign-ups never spend a bcrypt hash.
    const record = await db('student_records').where({ matric_no: id }).first();
    if (!record) return rejectRegistration('not_in_records', id, ctx);
    const taken = await db('users').where({ matric_or_staff_id: id }).orWhere({ email: mail }).first('id');
    if (taken) return rejectRegistration('already_registered_or_email_taken', id, ctx);

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
      ctx.log.info({ event: 'register_success', userId: row.id }, 'student registered');
      await audit.record('register', { userId: row.id, subject: id, success: true }, ctx);
      return { ok: true, userId: row.id };
    } catch (err) {
      // A concurrent registration won the race for the same ID or email.
      if (err.code === UNIQUE_VIOLATION) return rejectRegistration('unique_violation', id, ctx);
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
        'users.two_factor_enabled',
        'users.two_factor_method',
        'roles.name as role',
        // Compare against the DB clock so app/DB clock skew cannot matter.
        db.raw('(users.locked_until IS NOT NULL AND users.locked_until > now()) AS is_locked'),
      );
  }

  /**
   * Password step. Returns one of:
   *   { ok: false, reason, policy }                       any failure (identical 401 to the client)
   *   { ok: true, status: 'signed_in', user }              no second factor needed
   *   { ok: true, status: 'second_factor_required', user } 2FA account: password correct, second factor pending
   *   { ok: true, status: 'enrolment_required', user }     admin without TOTP: may only enrol (FR-A13)
   * For 2FA accounts a correct password does NOT reset the failure counter;
   * only a completed second factor does, so knowing the password does not
   * give unlimited code guesses.
   */
  async function login({ identifier, password }, ctx = { log: logger }) {
    const { log } = ctx;
    const policy = await getPolicy(db);
    const user = await findForLogin(identifier);

    // Same-cost dummy compare so these paths take as long as a real check.
    if (!user || !user.is_active || user.is_locked) {
      await hasher.compare(password, await hasher.dummyHash());
      const reason = !user ? 'unknown_user' : !user.is_active ? 'inactive' : 'locked';
      log.info({ event: 'login_failure', reason, userId: user ? user.id : undefined }, 'login failed');
      await audit.record(
        'login_failure',
        { userId: user ? user.id : null, subject: identifier, success: false, details: { reason, stage: 'password' } },
        ctx,
      );
      return { ok: false, reason, policy };
    }

    const matches = await hasher.compare(password, user.password_hash);
    if (!matches) {
      const result = await recordFailure(db, user.id, policy);
      await noteFailure(audit, ctx, user.id, result, { reason: 'bad_password', stage: 'password' });
      return { ok: false, reason: 'bad_password', policy };
    }

    const summary = { id: user.id, role: user.role, method: user.two_factor_method };
    // FR-A13: an admin without TOTP cannot sign in; they may only enrol TOTP.
    if (user.role === 'admin' && !(user.two_factor_enabled && user.two_factor_method === 'totp')) {
      log.info({ event: 'admin_totp_enrolment_required', userId: user.id }, 'admin must enrol TOTP');
      await audit.record('admin_enrolment_required', { userId: user.id, success: true }, ctx);
      return { ok: true, status: 'enrolment_required', user: summary };
    }
    if (user.two_factor_enabled) {
      log.info({ event: 'password_ok_second_factor_pending', userId: user.id, method: user.two_factor_method }, 'second factor required');
      await audit.record('second_factor_required', { userId: user.id, success: true, details: { method: user.two_factor_method } }, ctx);
      return { ok: true, status: 'second_factor_required', user: summary };
    }

    await completeLogin(db, user.id);
    log.info({ event: 'login_success', userId: user.id, role: user.role }, 'login succeeded');
    await audit.record('login_success', { userId: user.id, success: true, details: { method: 'password' } }, ctx);
    return { ok: true, status: 'signed_in', user: summary };
  }

  return { register, login };
}

module.exports = { createAuthService };
