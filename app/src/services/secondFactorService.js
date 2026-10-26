'use strict';

const { getPolicy } = require('../policies/policyRepo');
const { recordFailure, completeLogin, loadAccount, noteFailure } = require('./accountState');
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
 * Every outcome is audited (FR-L1; fail open).
 *
 * Results: { status: 'signed_in', user } | { status: 'invalid' } | { status: 'restart' }
 */
function createSecondFactorService({ db, preauthTickets, otp, verifiers = {}, maxAttempts, logger, audit }) {
  async function sendLoginCode(account, ctx, { resend = false } = {}) {
    try {
      await otp.issue(account, { purpose: 'login', subject: LOGIN_SUBJECT, intro: LOGIN_INTRO });
    } catch (err) {
      if (err instanceof DeliveryError) {
        ctx.log.error({ event: 'otp_delivery_failed', userId: account.id, error: safeError(err) }, 'sign-in code could not be sent');
        await audit.record('otp_delivery_failed', { userId: account.id, success: false, details: { purpose: 'login', channel: otp.channel } }, ctx);
      }
      throw err;
    }
    ctx.log.info({ event: 'otp_sent', userId: account.id, purpose: 'login', resend }, 'sign-in code sent');
    await audit.record('otp_sent', { userId: account.id, success: true, details: { purpose: 'login', channel: otp.channel } }, ctx);
  }

  /** Issue the ticket and, for email 2FA, send the first code. Delivery problems do not fail the login. */
  async function start(user, ctx = { log: logger }) {
    // stepUp 'risk' (FR-A11): an emailed code for a risky sign-in on an account without 2FA.
    const ticket = await preauthTickets.issue({ userId: user.id, method: user.method, ...(user.stepUp ? { stepUp: user.stepUp } : {}) });
    const result = { ticket, method: user.method, codeSent: false };
    if (user.method !== 'email') return result;

    try {
      await sendLoginCode(await loadAccount(db, user.id), ctx);
      result.codeSent = true;
    } catch (err) {
      if (err instanceof CooldownError) result.retryAfterSec = err.retryAfterSec; // a recent code is still valid
      else if (err instanceof DeliveryError) result.deliveryFailed = true;
      else throw err;
    }
    return result;
  }

  // TOTP users fall back to backup codes only, never to email.
  function methodAllowed(ticketMethod, attempted) {
    if (ticketMethod === 'email') return attempted === 'email';
    if (ticketMethod === 'totp') return attempted === 'totp' || attempted === 'backup';
    return false;
  }

  /** Shared checks before any code is compared. Returns { data, account } or { reason } (restart). */
  async function openTicket(ticket, method) {
    const data = await preauthTickets.get(ticket);
    if (!data) return { reason: 'ticket_missing_or_expired' };
    if (!methodAllowed(data.method, method)) return { reason: 'method_not_allowed', userId: data.userId };
    if ((await preauthTickets.attempt(ticket, maxAttempts)) < 0) return { reason: 'ticket_attempts_used', userId: data.userId };
    const account = await loadAccount(db, Number(data.userId));
    const secondFactorExpected = account && (account.two_factor_enabled || (data.stepUp === 'risk' && data.method === 'email'));
    if (!account || !account.is_active || account.is_locked || !secondFactorExpected) {
      await preauthTickets.consume(ticket);
      return { reason: !account || !account.is_active ? 'inactive' : account.is_locked ? 'locked' : 'two_factor_off', userId: data.userId };
    }
    return { data, account };
  }

  async function finish(ticket, account, outcome, method, ctx) {
    const { log } = ctx;
    if (outcome === 'ok') {
      if (!(await preauthTickets.consume(ticket))) return { status: 'restart' }; // a parallel request won
      await completeLogin(db, account.id);
      log.info({ event: 'login_success', userId: account.id, role: account.role, secondFactor: method }, 'login succeeded');
      if (method === 'email') await audit.record('otp_verified', { userId: account.id, success: true, details: { purpose: 'login' } }, ctx);
      if (method === 'backup') await audit.record('backup_code_used', { userId: account.id, success: true }, ctx);
      await audit.record('login_success', { userId: account.id, success: true, details: { method } }, ctx);
      return { status: 'signed_in', user: { id: account.id, role: account.role } };
    }
    if (outcome === 'wrong') {
      if (method === 'email') await audit.record('otp_failed', { userId: account.id, success: false, details: { purpose: 'login', reason: 'wrong' } }, ctx);
      const result = await recordFailure(db, account.id, await getPolicy(db));
      await noteFailure(audit, ctx, account.id, result, { reason: `bad_${method}`, stage: 'second_factor', method });
      if (result && result.locked_until) await preauthTickets.consume(ticket);
    } else {
      log.info({ event: 'second_factor_unavailable', userId: account.id, method }, 'no usable code (not counted)');
      if (method === 'email') await audit.record('otp_failed', { userId: account.id, success: false, details: { purpose: 'login', reason: 'unavailable' } }, ctx);
    }
    return { status: 'invalid' };
  }

  async function verify(ticket, method, code, ctx = { log: logger }) {
    const opened = await openTicket(ticket, method);
    if (!opened.account) {
      await audit.record(
        'login_failure',
        { userId: opened.userId ? Number(opened.userId) : null, success: false, details: { reason: opened.reason, stage: 'second_factor', method } },
        ctx,
      );
      return { status: 'restart' };
    }
    const { account } = opened;

    let outcome;
    if (method === 'email') outcome = await otp.verify(account.id, code);
    else outcome = await verifiers[method](account, code);
    return finish(ticket, account, outcome, method, ctx);
  }

  /** Resend the email code (cooldown applies). Does not use a ticket attempt. */
  async function resend(ticket, ctx = { log: logger }) {
    const data = await preauthTickets.get(ticket);
    if (!data || data.method !== 'email') return { status: 'restart' };
    const account = await loadAccount(db, Number(data.userId));
    if (!account || !account.is_active || account.is_locked) return { status: 'restart' };
    await sendLoginCode(account, ctx, { resend: true });
    return { status: 'sent' };
  }

  return { start, verify, resend };
}

module.exports = { createSecondFactorService };
