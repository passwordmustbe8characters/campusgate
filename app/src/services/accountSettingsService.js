'use strict';

const { loadAccount } = require('./accountState');

class SettingsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
    this.publicMessage = message;
  }
}

/**
 * Security settings reached with the interim account ticket (Phase 2).
 * Email 2FA: send a code to the account email, confirm it, then 2FA is on.
 * Admins must use TOTP (FR-A13), so they cannot choose email.
 */
function createAccountSettingsService({ db, otp, totp, logger }) {
  async function requireAccount(userId) {
    const account = await loadAccount(db, userId);
    if (!account || !account.is_active || account.is_locked) throw new SettingsError(401, 'Please sign in again.');
    return account;
  }

  async function startEmail2fa(userId, { log = logger } = {}) {
    const account = await requireAccount(userId);
    if (account.role === 'admin') throw new SettingsError(403, 'Administrators must use an authenticator app.');
    if (account.two_factor_enabled) throw new SettingsError(409, 'Two-step sign-in is already on.');
    await otp.issue(account, {
      purpose: 'enable',
      subject: 'Confirm two-step sign-in for CampusGate',
      intro: 'You asked to turn on two-step sign-in with email codes.',
    });
    log.info({ event: 'otp_sent', userId, purpose: 'enable_email_2fa' }, 'confirmation code sent');
  }

  async function confirmEmail2fa(userId, code, { log = logger } = {}) {
    const account = await requireAccount(userId);
    if (account.two_factor_enabled) throw new SettingsError(409, 'Two-step sign-in is already on.');
    const outcome = await otp.verify(userId, code);
    if (outcome !== 'ok') throw new SettingsError(400, 'Invalid or expired code.');
    const updated = await db('users')
      .where({ id: userId, two_factor_enabled: false })
      .update({ two_factor_enabled: true, two_factor_method: 'email' });
    if (updated !== 1) throw new SettingsError(409, 'Two-step sign-in is already on.');
    log.info({ event: '2fa_enabled', userId, method: 'email' }, 'email two-step sign-in enabled');
  }

  /** TOTP enrolment (FR-A8). Returns the QR code and the secret for manual entry (shown once). */
  async function startTotp(userId, { log = logger } = {}) {
    const account = await requireAccount(userId);
    const result = await totp.startEnrolment(account);
    log.info({ event: 'totp_enrolment_started', userId }, 'TOTP enrolment started');
    return result;
  }

  /** Confirm TOTP with one code; returns the 8 backup codes (shown once, stored hashed). */
  async function confirmTotp(userId, code, { log = logger } = {}) {
    const account = await requireAccount(userId);
    const result = await totp.confirmEnrolment(account, code);
    log.info({ event: '2fa_enabled', userId, method: 'totp', backupCodesIssued: result.backupCodes.length }, 'TOTP enabled');
    return result;
  }

  async function status(userId) {
    const account = await requireAccount(userId);
    return {
      matric: account.matric_or_staff_id,
      role: account.role,
      twoFactorEnabled: account.two_factor_enabled,
      twoFactorMethod: account.two_factor_method,
    };
  }

  return { requireAccount, startEmail2fa, confirmEmail2fa, startTotp, confirmTotp, status };
}

module.exports = { createAccountSettingsService, SettingsError };
