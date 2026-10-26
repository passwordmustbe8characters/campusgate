'use strict';

const { normalizeId, normalizeEmail, looksLikeEmail } = require('./identity');

const byIdentifier = (identifier) =>
  looksLikeEmail(identifier)
    ? { email: normalizeEmail(identifier) }
    : { matric_or_staff_id: normalizeId(identifier) };

const STATUS_COLUMNS = [
  'matric_or_staff_id', 'email', 'is_active', 'failed_attempts', 'locked_until', 'last_login',
  'two_factor_enabled', 'two_factor_method',
];

function requireAudit(audit) {
  if (!audit || typeof audit.recordCritical !== 'function') {
    throw new Error('admin actions must be audited: pass { audit, ctx }');
  }
}

/**
 * Admin unlock (FR-A6): clears the failure counter and the lock.
 * Returns the updated row, or null when no such user exists.
 *
 * Audited FAIL CLOSED (FR-L1, FR-Z5): the unlock and its audit row commit
 * together; if the audit row cannot be written, nothing is unlocked.
 * CLI only for now (scripts/admin-cli.js).
 * TODO(Phase 6): call this from the admin console (/admin/users/:id/unlock).
 */
async function unlockUser(db, identifier, { audit, ctx = {} } = {}) {
  requireAudit(audit);
  return db.transaction(async (trx) => {
    const [row] = await trx('users')
      .where(byIdentifier(identifier))
      .update({ failed_attempts: 0, locked_until: null })
      .returning(['id', ...STATUS_COLUMNS]);
    if (!row) return null;
    await audit.recordCritical(trx, 'admin_unlock', { userId: row.id, success: true, details: { actor: ctx.actor || 'cli' } }, ctx);
    const { id, ...status } = row;
    return status;
  });
}

/**
 * Lost-device recovery: turn 2FA off and remove the TOTP secret, backup codes
 * and open OTP codes. The user (an admin must re-enrol TOTP at next sign-in,
 * FR-A13) signs in with the password only until they set 2FA up again.
 * Returns the updated row, or null when no such user exists.
 * Audited FAIL CLOSED, in the same transaction.
 */
async function resetTwoFactor(db, identifier, { audit, ctx = {} } = {}) {
  requireAudit(audit);
  return db.transaction(async (trx) => {
    const [row] = await trx('users')
      .where(byIdentifier(identifier))
      .update({ two_factor_enabled: false, two_factor_method: null, totp_secret_enc: null, totp_last_step: null })
      .returning(['id', 'matric_or_staff_id', 'two_factor_enabled']);
    if (!row) return null;
    const backupCodes = await trx('totp_backup_codes').where({ user_id: row.id }).del();
    await trx('otp_codes').where({ user_id: row.id, used: false }).update({ used: true });
    await audit.recordCritical(
      trx,
      'admin_reset_2fa',
      { userId: row.id, success: true, details: { actor: ctx.actor || 'cli', backupCodesRemoved: backupCodes } },
      ctx,
    );
    return { ...row, backupCodesRemoved: backupCodes };
  });
}

/**
 * Deactivate or reactivate an account (FR-D2). An inactive account cannot sign
 * in (same generic error as a wrong password). Returns the updated row, or
 * null when no such user exists. Audited FAIL CLOSED, in the same transaction.
 * The caller revokes the user's sessions after deactivating.
 */
async function setUserActive(db, identifier, active, { audit, ctx = {} } = {}) {
  requireAudit(audit);
  return db.transaction(async (trx) => {
    const [row] = await trx('users')
      .where(byIdentifier(identifier))
      .update({ is_active: Boolean(active) })
      .returning(['id', ...STATUS_COLUMNS]);
    if (!row) return null;
    await audit.recordCritical(trx, 'admin_user_status', { userId: row.id, success: true, details: { actor: ctx.actor || 'cli', active: Boolean(active) } }, ctx);
    return row;
  });
}

/** Search accounts by matric/staff ID or email (prefix, case-insensitive). */
async function searchUsers(db, text, { limit = 50 } = {}) {
  const q = db('users').join('roles', 'roles.id', 'users.role_id')
    .select(...STATUS_COLUMNS.map((c) => `users.${c}`), 'roles.name as role',
      db.raw('(users.locked_until IS NOT NULL AND users.locked_until > now()) AS is_locked'))
    .orderBy('users.matric_or_staff_id').limit(limit);
  const t = typeof text === 'string' ? text.trim() : '';
  if (t === '') return q;
  const pattern = `${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return q.where((w) => w.whereRaw('users.matric_or_staff_id ILIKE ?', [pattern]).orWhereRaw('users.email ILIKE ?', [pattern]));
}

async function getUserStatus(db, identifier) {
  const row = await db('users')
    .where(byIdentifier(identifier))
    .first(...STATUS_COLUMNS, db.raw('(locked_until IS NOT NULL AND locked_until > now()) AS is_locked'));
  return row || null;
}

async function listLockedUsers(db) {
  return db('users')
    .whereRaw('locked_until > now()')
    .orderBy('locked_until')
    .select(...STATUS_COLUMNS);
}

module.exports = { unlockUser, resetTwoFactor, setUserActive, searchUsers, getUserStatus, listLockedUsers };
