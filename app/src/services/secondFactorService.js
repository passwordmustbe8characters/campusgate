'use strict';

const { getPolicy } = require('../policies/policyRepo');
const { recordFailure, completeLogin, loadAccount, logFailure } = require('./accountState');
const { CooldownError } = require('./otpService');
const { DeliveryError } = require('./delivery');
const { safeError } = require('./metrics');

const LOGIN_SUBJECT = 'Your CampusGate sign-in code';
const LOGIN_INTRO = 'Someone (hopefully you) entered your password on CampusGate.';

/**
 * Second step of sign-in (FR-A7, FR-A8). Works on a pre-auth ticket issued
 * after a correct password:
 *  - each verification attempt uses one ticket attempt (PREAUTH_MAX_ATTEMPTS);
 *  - a code that was compared and is wrong counts as a credential failure
 *    toward account lockout (same counter as wrong passwords);
 *  - expired / exhausted / missing codes, delivery failures, timeouts and
 *    Redis or DB errors never count (FR-P5);
 *  - success consumes the ticket (single use) and resets the counter.
 *
 * Results: { status: 'signed_in', user } | { status: 'invalid' } | { status: 'restart' }
 */
function createSecondFactorService({ db, preauthTickets, otp, verifiers = {}, maxAttempts, logger }) {
  /** Issue the ticket and, for email 2FA, send the first code. Delivery problems do not fail the login. */
  async function start(user, { log = logger } = {}) {
    const ticket = await preauthTickets.issue({ userId: user.id, method: user.method });
    const result = { ticket, method: user.method, codeSent: false };
    if (user.method !== 'email') return result;

    try {
      await otp.issue(await loadAccount(db, user.id), { purpose: 'login', subject: LOGIN_SUBJECT, intro: LOGIN_INTRO });
      result.codeSent = true;
      log.info({ event: 'otp_sent', userId: user.id, purpose: 'login' }, 'sign-in code sent');
    } catch (err) {
      if (err instanceof CooldownError) {
        result.retryAfterSec = err.retryAfterSec; // a recent code is still valid
      } else if (err instanceof DeliveryError) {
        result.deliveryFailed = true;
        log.error({ event: 'otp_delivery_failed', userId: user.id, error: safeError(err) }, 'sign-in code could not be sent');
      } else {
        throw err;
      }
    }
    return result;
  }

  /** Shared checks before any code is compared. Returns { data, account } or null (restart). */
  async function openTicket(ticket, method) {
    const data = await preauthTickets.get(ticket);
    if (!data || !methodAllowed(data.method, method)) return null;
    if ((await preauthTickets.attempt(ticket, maxAttempts)) < 0) return null;
    const account = await loadAccount(db, Number(data.userId));
    if (!account || !account.is_active || account.is_locked || !account.two_factor_enabled) {
      await preauthTickets.consume(ticket);
      return null;
    }
    return { data, account };
  }

  // TOTP users fall back to backup codes only, never to email.
  function methodAllowed(ticketMethod, attempted) {
    if (ticketMethod === 'email') return attempted === 'email';
    if (ticketMethod === 'totp') return attempted === 'totp' || attempted === 'backup';
    return false;
  }

  async function finish(ticket, account, outcome, { log, method }) {
    if (outcome === 'ok') {
      if (!(await preauthTickets.consume(ticket))) return { status: 'restart' }; // a parallel request won
      await completeLogin(db, account.id);
      log.info({ event: 'login_success', userId: account.id, role: account.role, secondFactor: method }, 'login succeeded');
      return { status: 'signed_in', user: { id: account.id, role: account.role } };
    }
    if (outcome === 'wrong') {
      const result = await recordFailure(db, account.id, await getPolicy(db));
      logFailure(log, account.id, result, { reason: `bad_${method}` });
      if (result && result.locked_until) await preauthTickets.consume(ticket);
    } else {
      log.info({ event: 'second_factor_unavailable', userId: account.id, method }, 'no usable code (not counted)');
    }
    return { status: 'invalid' };
  }

  async function verify(ticket, method, code, { log = logger } = {}) {
    const opened = await openTicket(ticket, method);
    if (!opened) return { status: 'restart' };
    const { account } = opened;

    let outcome;
    if (method === 'email') outcome = await otp.verify(account.id, code);
    else outcome = await verifiers[method](account, code);
    return finish(ticket, account, outcome, { log, method });
  }

  /** Resend the email code (cooldown applies). Does not use a ticket attempt. */
  async function resend(ticket, { log = logger } = {}) {
    const data = await preauthTickets.get(ticket);
    if (!data || data.method !== 'email') return { status: 'restart' };
    const account = await loadAccount(db, Number(data.userId));
    if (!account || !account.is_active || account.is_locked) return { status: 'restart' };
    await otp.issue(account, { purpose: 'login', subject: LOGIN_SUBJECT, intro: LOGIN_INTRO });
    log.info({ event: 'otp_sent', userId: account.id, purpose: 'login', resend: true }, 'sign-in code re-sent');
    return { status: 'sent' };
  }

  return { start, verify, resend };
}

module.exports = { createSecondFactorService };
