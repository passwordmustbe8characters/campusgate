'use strict';

const { getPolicy } = require('../policies/policyRepo');
const { checkPassword } = require('./passwordPolicy');
const { normalizeEmail } = require('./identity');
const { keyedHash, randomToken } = require('./secrets');
const { recordFailure, loadAccount, logFailure } = require('./accountState');
const { safeError } = require('./metrics');

class PasswordError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.name = 'PasswordError';
    this.status = status;
    this.publicMessage = message;
    this.fields = fields;
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url

/**
 * Password reset (FR-A9) and change (FR-A10).
 *
 * - forgot(): the caller answers immediately with the same 202 for every
 *   email; lookup, token creation and sending happen afterwards in the
 *   background, so response time does not depend on whether the email exists
 *   or how slow the mail server is. Background failures are logged (without
 *   email addresses) and counted, never swallowed.
 * - Tokens: 32 random bytes, stored as an HMAC, expire after RESET_TOKEN_TTL_MIN,
 *   single use; a new request cancels older unused tokens.
 * - reset(): same password policy; clears an existing lockout (the old
 *   password it protected no longer exists) but never touches 2FA.
 * - reset() and change() revoke the user's pre-auth and account tickets and
 *   send a "password changed" email without blocking the request.
 *   TODO(Phase 4): also revoke the user's sessions (FR-A10 "log out other sessions").
 */
function createPasswordService({ db, redis, hasher, delivery, config, tickets, metrics, logger }) {
  const hashToken = (token) => keyedHash(config.tokenHmacKey, 'reset', token);

  // Background work in flight (reset emails, notifications). Graceful shutdown
  // and tests wait for it with idle().
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {}); // never an unhandled rejection
    return promise;
  };
  const idle = () => Promise.allSettled([...pending]);
  const emailCooldownKey = (email) => `cg:cooldown:reset:${keyedHash(config.tokenHmacKey, 'reset-email', email)}`;

  async function revokeTickets(userId) {
    await Promise.all(tickets.map((store) => store.revokeUser(userId)));
  }

  /** Fire-and-forget notification; failures are logged and counted. */
  function notifyPasswordChanged(account, how, log) {
    const send = delivery.send({
      email: account.email,
      matric: account.matric_or_staff_id,
      subject: 'Your CampusGate password was changed',
      text:
        `The password for ${account.matric_or_staff_id} was just changed (${how}).\n\n` +
        'If this was you, no action is needed. If it was not, reset your password now and contact the ICT help desk.',
    });
    return track(send
      .then(() => {
        log.info({ event: 'password_changed_notice_sent', userId: account.id }, 'password-changed email sent');
      })
      .catch(async (err) => {
        await metrics.incr('notification_email_failures');
        // Logged under `error`, not `err`: pino's err serializer would reshape the scrubbed object.
        log.error({ event: 'password_changed_notice_failed', userId: account.id, error: safeError(err) }, 'password-changed email failed');
      }));
  }

  async function sendResetEmail(rawEmail, log) {
    const email = normalizeEmail(rawEmail);
    const set = await redis.set(emailCooldownKey(email), '1', 'EX', config.resetCooldownSec, 'NX');
    if (set !== 'OK') {
      log.info({ event: 'reset_request_cooldown' }, 'reset request ignored (cooldown)');
      return 'cooldown';
    }

    const user = await db('users').where({ email }).first('id', 'email', 'matric_or_staff_id', 'is_active');
    if (!user || !user.is_active) {
      log.info({ event: 'reset_request_no_account' }, 'reset requested for an email with no active account');
      return 'no_account';
    }

    const token = randomToken(32);
    await db.transaction(async (trx) => {
      await trx('password_reset_tokens').where({ user_id: user.id, used: false }).update({ used: true });
      await trx('password_reset_tokens').insert({
        user_id: user.id,
        token_hash: hashToken(token),
        expires_at: trx.raw('now() + make_interval(mins => ?::int)', [config.resetTokenTtlMin]),
      });
    });

    // Token in the URL fragment (#): browsers never send it to the server, so it
    // cannot end up in request logs or Referer headers.
    const link = `${config.appBaseUrl}/reset-password#token=${token}`;
    await delivery.send({
      email: user.email,
      matric: user.matric_or_staff_id,
      subject: 'Reset your CampusGate password',
      text:
        `Someone asked to reset the password for ${user.matric_or_staff_id}.\n\n` +
        `Open this link within ${config.resetTokenTtlMin} minutes to choose a new password:\n${link}\n\n` +
        'The link works once. If you did not ask for this, ignore this email; your password has not changed.',
    });
    await metrics.incr('reset_emails_sent');
    log.info({ event: 'reset_email_sent', userId: user.id }, 'reset email sent');
    return 'sent';
  }

  /**
   * Start the background work and return immediately. `done` resolves when it
   * finishes (tests await it; the HTTP handler does not).
   */
  function forgot(email, { log = logger } = {}) {
    const done = track(new Promise((resolve) => setImmediate(resolve))
      .then(() => sendResetEmail(email, log))
      .catch(async (err) => {
        await metrics.incr('reset_email_failures');
        log.error({ event: 'reset_email_failed', error: safeError(err) }, 'reset email could not be sent');
        return 'failed';
      }));
    return { done };
  }

  function assertPolicy(password, policy, field) {
    const problems = checkPassword(password, policy);
    if (problems.length > 0) throw new PasswordError(400, 'Please correct the highlighted fields.', { [field]: problems });
  }

  async function reset(token, newPassword, { log = logger } = {}) {
    const invalid = () => new PasswordError(400, 'This reset link is invalid or has expired. Request a new one.');
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalid();
    assertPolicy(newPassword, await getPolicy(db), 'newPassword');

    // Cheap validity check first, so an invalid token never costs a bcrypt hash.
    const tokenHash = hashToken(token);
    const open = await db('password_reset_tokens')
      .where({ token_hash: tokenHash, used: false })
      .andWhere('expires_at', '>', db.fn.now())
      .first('id');
    if (!open) throw invalid();

    const passwordHash = await hasher.hash(newPassword);
    const userId = await db.transaction(async (trx) => {
      // Consume atomically: of two concurrent resets with one token, only one wins.
      const [row] = await trx('password_reset_tokens')
        .where({ id: open.id, used: false })
        .andWhere('expires_at', '>', trx.fn.now())
        .update({ used: true })
        .returning('user_id');
      if (!row) throw invalid();
      await trx('password_reset_tokens').where({ user_id: row.user_id, used: false }).update({ used: true });
      // Clear any lockout; 2FA settings are deliberately left untouched.
      await trx('users').where({ id: row.user_id }).update({ password_hash: passwordHash, failed_attempts: 0, locked_until: null });
      return row.user_id;
    });

    await revokeTickets(userId);
    log.info({ event: 'password_reset', userId }, 'password reset with emailed token');
    const notified = notifyPasswordChanged(await loadAccount(db, userId), 'reset by email link', log);
    return { userId, notified };
  }

  async function change(userId, currentPassword, newPassword, { log = logger } = {}) {
    const account = await loadAccount(db, userId);
    if (!account || !account.is_active || account.is_locked) throw new PasswordError(401, 'Please sign in again.');
    const user = await db('users').where({ id: userId }).first('id', 'password_hash');

    if (!(await hasher.compare(currentPassword, user.password_hash))) {
      // A wrong current password is a credential failure like any other.
      const result = await recordFailure(db, userId, await getPolicy(db));
      logFailure(log, userId, result, { reason: 'bad_current_password' });
      throw new PasswordError(400, 'Please correct the highlighted fields.', { currentPassword: ['Current password is not correct.'] });
    }
    assertPolicy(newPassword, await getPolicy(db), 'newPassword');

    await db('users').where({ id: userId }).update({ password_hash: await hasher.hash(newPassword) });
    await revokeTickets(userId);
    log.info({ event: 'password_changed', userId }, 'password changed');
    const notified = notifyPasswordChanged(account, 'changed in security settings', log);
    return { notified };
  }

  return { forgot, reset, change, idle };
}

module.exports = { createPasswordService, PasswordError };
