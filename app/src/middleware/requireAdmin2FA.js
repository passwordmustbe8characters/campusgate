'use strict';

const { loadAccount } = require('../services/accountState');

/**
 * FR-A13: admin routes require an admin account with TOTP turned on.
 * Enforced regardless of policies.require_2fa_admin (that column is pinned to
 * true by a CHECK constraint and is not exposed as a setting).
 *
 * Expects req.account.userId (set by the account ticket in Phase 2).
 * TODO(Phase 3/4/6): put this in front of every /admin/* route, reading the
 * user from the JWT session instead of the interim account ticket.
 */
function requireAdmin2FA({ db }) {
  return async (req, res, next) => {
    const account = req.account && (await loadAccount(db, req.account.userId));
    if (!account || account.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (!account.two_factor_enabled || account.two_factor_method !== 'totp') {
      return res.status(403).json({ error: 'Administrators must turn on an authenticator app first.', enrolmentRequired: true });
    }
    return next();
  };
}

module.exports = { requireAdmin2FA };
