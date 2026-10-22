'use strict';

const { loadAccount } = require('./accountState');
const { DeliveryError } = require('./delivery');

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
 *
 * Audit (FR-L1): turning 2FA on is an account-security change, so its audit
 * event is written in the SAME transaction as the change (fail closed). Codes
 * sent and failed are high volume (fail open).
 */
function createAccountSettingsService({ db, otp, totp, logger, audit }) {
  async function requireAccount(userId) {
    const account = await loadAccount(db, userId);
    if (!account || !account.is_active || account.is_locked) throw new SettingsError(401, 'Please sign in again.');
    return account;
  }

  async function startEmail2fa(userId, ctx = { log: logger }) {
    const account = await requireAccount(userId);
    if (account.role === 'admin') throw new SettingsError(403, 'Administrators must use an authenticator app.');
    if (account.two_factor_enabled) throw new SettingsError(409, 'Two-step sign-in is already on.');
    try {
      await otp.issue(account, {
        purpose: 'enable',
        subject: 'Confirm two-step sign-in for CampusGate',
        intro: 'You asked to turn on two-step sign-in with email codes.',
      });
    } catch (err) {
      if (err instanceof DeliveryError) {
        await audit.record('otp_delivery_failed', { userId, success: false, details: { purpose: 'enable_2fa', channel: otp.channel } }, ctx);
      }
      throw err;
    }
    ctx.log.info({ event: 'otp_sent', userId, purpose: 'enable_email_2fa' }, 'confirmation code sent');
    await audit.record('otp_sent', { userId, success: true, details: { purpose: 'enable_2fa', channel: otp.channel } }, ctx);
  }

  async function confirmEmail2fa(userId, code, ctx = { log: logger }) {
    const account = await requireAccount(userId);
    if (account.two_factor_enabled) throw new SettingsError(409, 'Two-step sign-in is already on.');
    const outcome = await otp.verify(userId, code);
    if (outcome !== 'ok') {
      await audit.record('otp_failed', { userId, success: false, details: { purpose: 'enable_2fa', reason: outcome } }, ctx);
      throw new SettingsError(400, 'Invalid or expired code.');
    }
    await audit.record('otp_verified', { userId, success: true, details: { purpose: 'enable_2fa' } }, ctx);
    await db.transaction(async (trx) => {
      const updated = await trx('users')
        .where({ id: userId, two_factor_enabled: false })
        .update({ two_factor_enabled: true, two_factor_method: 'email' });
      if (updated !== 1) throw new SettingsError(409, 'Two-step sign-in is already on.');
      // Fail closed: if the audit row cannot be written, the change rolls back.
      await audit.recordCritical(trx, 'two_factor_enabled', { userId, success: true, details: { method: 'email' } }, ctx);
    });
    ctx.log.info({ event: '2fa_enabled', userId, method: 'email' }, 'email two-step sign-in enabled');
  }

  /** TOTP enrolment (FR-A8). Returns the QR code and the secret for manual entry (shown once). */
  async function startTotp(userId, ctx = { log: logger }) {
    const account = await requireAccount(userId);
    const result = await totp.startEnrolment(account);
    ctx.log.info({ event: 'totp_enrolment_started', userId }, 'TOTP enrolment started');
    await audit.record('totp_enrolment_started', { userId, success: true }, ctx);
    return result;
  }

  /** Confirm TOTP with one code; returns the 8 backup codes (shown once, stored hashed). */
  async function confirmTotp(userId, code, ctx = { log: logger }) {
    const account = await requireAccount(userId);
    const result = await totp.confirmEnrolment(account, code, {
      // Runs inside the enrolment transaction: fail closed.
      beforeCommit: (trx) =>
        audit.recordCritical(trx, 'two_factor_enabled', { userId, success: true, details: { method: 'totp' } }, ctx),
    });
    ctx.log.info({ event: '2fa_enabled', userId, method: 'totp', backupCodesIssued: result.backupCodes.length }, 'TOTP enabled');
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
