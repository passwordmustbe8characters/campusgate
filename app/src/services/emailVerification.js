'use strict';

const { keyedHash, randomToken } = require('./secrets');
const { safeError } = require('./metrics');
const { createBackgroundWork } = require('./backgroundWork');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const TOKEN_TTL_HOURS = 24;

/**
 * Email verification (FR-A2). A new account cannot sign in until its owner
 * opens the emailed link. Tokens: 32 random bytes, stored only as an HMAC,
 * valid 24 hours, single use; a new link cancels older ones. The link puts
 * the token after "#", so it never reaches server logs (same as password reset).
 * Sending happens after the response, never in the request path.
 */
function createEmailVerification({ db, redis, delivery, config, metrics, logger, audit }) {
  const work = createBackgroundWork();
  const hashToken = (token) => keyedHash(config.tokenHmacKey, 'verify-email', token);
  const cooldownKey = (userId) => `cg:cooldown:verify:${userId}`;

  async function sendLink(userId, ctx) {
    const account = await db('users').where({ id: userId }).first('id', 'email', 'matric_or_staff_id', 'email_verified');
    if (!account || account.email_verified) return;
    const token = randomToken(32);
    await db.transaction(async (trx) => {
      await trx('email_verifications').where({ user_id: userId, used: false }).update({ used: true });
      await trx('email_verifications').insert({
        user_id: userId,
        token_hash: hashToken(token),
        expires_at: trx.raw(`now() + interval '${TOKEN_TTL_HOURS} hours'`),
      });
    });
    await delivery.send({
      email: account.email,
      matric: account.matric_or_staff_id,
      subject: 'Confirm your CampusGate email address',
      text:
        `Welcome to CampusGate, ${account.matric_or_staff_id}.\n\n` +
        `Open this link to confirm your email address and activate sign-in (valid for ${TOKEN_TTL_HOURS} hours):\n` +
        `${config.appBaseUrl}/verify-email#token=${token}\n\n` +
        'If you did not create this account, ignore this message.',
    });
    ctx.log.info({ event: 'verification_email_sent', userId }, 'verification email sent');
  }

  /** Send (or re-send) the link in the background. A 60 s cooldown per account limits re-sends. */
  async function requestLink(userId, ctx = { log: logger }) {
    const ok = await redis.set(cooldownKey(userId), '1', 'EX', config.otpResendCooldownSec, 'NX').catch(() => 'OK');
    if (ok !== 'OK') return false;
    work.track(sendLink(userId, ctx).catch(async (err) => {
      await metrics.incr('verification_email_failures');
      ctx.log.error({ event: 'verification_email_failed', userId, error: safeError(err) }, 'verification email failed');
    }));
    return true;
  }

  /** Use a token: marks the email verified. Returns true once; false for invalid, used or expired tokens. */
  async function verify(token, ctx = { log: logger }) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const userId = await db.transaction(async (trx) => {
      const [row] = await trx('email_verifications')
        .where({ token_hash: hashToken(token), used: false })
        .where('expires_at', '>', trx.fn.now())
        .update({ used: true })
        .returning('user_id');
      if (!row) return null;
      await trx('users').where({ id: row.user_id }).update({ email_verified: true });
      return row.user_id;
    });
    if (!userId) return false;
    ctx.log.info({ event: 'email_verified', userId }, 'email address verified');
    await audit.record('email_verified', { userId, success: true }, ctx);
    return true;
  }

  return { requestLink, verify, idle: work.idle };
}

module.exports = { createEmailVerification, TOKEN_TTL_HOURS };
