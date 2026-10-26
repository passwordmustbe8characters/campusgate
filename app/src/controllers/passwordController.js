'use strict';

const { auditContext } = require('../audit/audit');
const { PasswordError } = require('../services/passwordService');

// Identical for every email address, existing or not (FR-A9).
const FORGOT_RESPONSE = Object.freeze({
  message: 'If an account exists for that email, we have sent a link to reset the password. Check your inbox.',
});

function createPasswordController({ passwordService, cookies }) {
  const respondError = (res, err) => {
    if (!(err instanceof PasswordError)) throw err;
    const body = { error: err.publicMessage };
    if (err.fields) body.fields = err.fields;
    if (err.status === 401) body.restart = true;
    return res.status(err.status).json(body);
  };

  /** Answer first; the lookup and email happen in the background. */
  function forgot(req, res) {
    passwordService.forgot(req.body.email, auditContext(req));
    res.status(202).json(FORGOT_RESPONSE);
  }

  async function reset(req, res) {
    try {
      await passwordService.reset(req.body.token, req.body.newPassword, auditContext(req));
    } catch (err) {
      return respondError(res, err);
    }
    return res.status(200).json({ message: 'Password changed. You can now sign in with your new password.' });
  }

  async function change(req, res) {
    try {
      await passwordService.change(req.account.userId, req.body.currentPassword, req.body.newPassword, auditContext(req));
    } catch (err) {
      return respondError(res, err);
    }
    // All of this user's sessions were revoked (FR-A10), including this one.
    cookies.clearSession(res);
    return res.status(200).json({ message: 'Password changed. Please sign in again with your new password.' });
  }

  return { forgot, reset, change };
}

module.exports = { createPasswordController, FORGOT_RESPONSE };
