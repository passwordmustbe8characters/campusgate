'use strict';

/**
 * Lockout bookkeeping shared by the password step and the second-factor step
 * (FR-A6, FR-P5). Only callers that have actually compared a credential and
 * found it wrong call recordFailure(); system errors never reach it.
 */

/**
 * Count one credential failure atomically. Concurrent failures serialize on
 * the row lock; the WHERE clause re-checks the lock, so once an account is
 * locked, further concurrent failures are not counted (and do not extend it).
 */
async function recordFailure(db, userId, policy) {
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

/** Full sign-in finished: reset the counter and record the time. */
async function completeLogin(db, userId) {
  await db('users').where({ id: userId }).update({
    failed_attempts: 0,
    locked_until: null,
    last_login: db.fn.now(),
  });
}

/** Current state of an account, for steps that happen after the password check. */
async function loadAccount(db, userId) {
  return db('users')
    .join('roles', 'roles.id', 'users.role_id')
    .where('users.id', userId)
    .first(
      'users.id',
      'users.email',
      'users.matric_or_staff_id',
      'users.is_active',
      'users.two_factor_enabled',
      'users.two_factor_method',
      'users.totp_secret_enc',
      'roles.name as role',
      db.raw('(users.locked_until IS NOT NULL AND users.locked_until > now()) AS is_locked'),
    );
}

/** Log a lockout once, when a failure has just locked the account. */
function logFailure(log, userId, result, extra) {
  log.info({ event: 'login_failure', userId, failedAttempts: result && result.failed_attempts, ...extra }, 'login failed');
  if (result && result.locked_until) {
    log.warn({ event: 'lockout', userId, lockedUntil: result.locked_until }, 'account locked');
  }
}

module.exports = { recordFailure, completeLogin, loadAccount, logFailure };
