'use strict';

const { normalizeId, normalizeEmail, looksLikeEmail } = require('./identity');

const byIdentifier = (identifier) =>
  looksLikeEmail(identifier)
    ? { email: normalizeEmail(identifier) }
    : { matric_or_staff_id: normalizeId(identifier) };

const STATUS_COLUMNS = ['matric_or_staff_id', 'email', 'is_active', 'failed_attempts', 'locked_until', 'last_login'];

/**
 * Admin unlock (FR-A6): clears the failure counter and the lock.
 * Returns the updated row, or null when no such user exists.
 *
 * Phase 1 exposes this through the CLI only (scripts/admin-cli.js).
 * TODO(Phase 3): write the unlock to the audit log (who, when, which account).
 * TODO(Phase 6): call this from the admin console (/admin/users/:id/unlock).
 */
async function unlockUser(db, identifier) {
  const [row] = await db('users')
    .where(byIdentifier(identifier))
    .update({ failed_attempts: 0, locked_until: null })
    .returning(STATUS_COLUMNS);
  return row || null;
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

module.exports = { unlockUser, getUserStatus, listLockedUsers };
