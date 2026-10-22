'use strict';

const { keyedHash, safeEqual, randomDigits } = require('./secrets');

const OTP_TTL_MIN = 5; // FR-A7
const OTP_MAX_ATTEMPTS = 3; // FR-A7 (also a CHECK constraint)

class CooldownError extends Error {
  constructor(retryAfterSec) {
    super('Please wait before requesting another code.');
    this.name = 'CooldownError';
    this.status = 429;
    this.retryAfterSec = retryAfterSec;
    this.publicMessage = `Please wait ${retryAfterSec} s before requesting another code.`;
  }
}

/**
 * Email OTP (FR-A7). Codes are 6 CSPRNG digits, stored only as an HMAC with
 * the server key, valid 5 minutes, max 3 attempts, single use. Issuing a new
 * code cancels older open codes. Sends have a per-account cooldown in Redis.
 */
function createOtpService({ db, redis, delivery, hmacKey, cooldownSec }) {
  const hashCode = (userId, code) => keyedHash(hmacKey, 'otp', `${userId}:${code}`);
  const cooldownKey = (userId, purpose) => `cg:cooldown:otp:${purpose}:${userId}`;

  /**
   * Send a fresh code. Throws CooldownError (429) inside the cooldown, or
   * DeliveryError (503) if the driver fails; neither ever counts toward lockout.
   */
  async function issue(account, { purpose = 'login', subject, intro }) {
    const key = cooldownKey(account.id, purpose);
    const set = await redis.set(key, '1', 'EX', cooldownSec, 'NX');
    if (set !== 'OK') throw new CooldownError(Math.max(1, await redis.ttl(key)));

    const code = randomDigits(6);
    const id = await db.transaction(async (trx) => {
      await trx('otp_codes').where({ user_id: account.id, used: false }).update({ used: true });
      const [row] = await trx('otp_codes')
        .insert({
          user_id: account.id,
          code_hash: hashCode(account.id, code),
          channel: delivery.name,
          expires_at: trx.raw(`now() + interval '${OTP_TTL_MIN} minutes'`),
        })
        .returning('id');
      return row.id;
    });

    try {
      await delivery.send({
        email: account.email,
        matric: account.matric_or_staff_id,
        subject,
        text: `${intro}\n\nYour CampusGate code is: ${code}\n\nIt expires in ${OTP_TTL_MIN} minutes. If you did not ask for it, ignore this message.`,
      });
    } catch (err) {
      // Delivery failed: cancel the code and lift the cooldown so the user can retry at once.
      await db('otp_codes').where({ id }).update({ used: true });
      await redis.del(key);
      throw err;
    }
    return { id };
  }

  /**
   * Check a code against the newest open code. The attempt is counted
   * atomically before comparing, so concurrent guesses get at most 3 checks.
   * Returns 'ok' | 'wrong' (a code was compared and did not match) |
   * 'unavailable' (no open code: expired, used, exhausted, or never sent).
   */
  async function verify(userId, code) {
    const { rows } = await db.raw(
      `UPDATE otp_codes SET attempts_used = attempts_used + 1
       WHERE id = (SELECT id FROM otp_codes WHERE user_id = ? AND used = false ORDER BY id DESC LIMIT 1)
         AND used = false AND expires_at > now() AND attempts_used < ?
       RETURNING id, code_hash`,
      [userId, OTP_MAX_ATTEMPTS],
    );
    if (rows.length === 0) return 'unavailable';
    if (!safeEqual(rows[0].code_hash, hashCode(userId, code))) return 'wrong';

    const used = await db('otp_codes').where({ id: rows[0].id, used: false }).update({ used: true });
    return used === 1 ? 'ok' : 'unavailable';
  }

  return { issue, verify, channel: delivery.name };
}

module.exports = { createOtpService, CooldownError, OTP_TTL_MIN, OTP_MAX_ATTEMPTS };
