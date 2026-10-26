'use strict';

const crypto = require('node:crypto');
const { keyedHash } = require('./secrets');

const VOUCHER_SERVICES = Object.freeze(['fees', 'hostel', 'course_registration']);
// No look-alike characters (0/O, 1/I/L). 8 characters = about 39 bits; redemption is rate limited.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const randomChars = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

/** "ab3k-9xyz " -> "AB3K9XYZ"; null if it cannot be a voucher code. */
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[2-9A-HJKMNP-Z]{8}$/.test(code) ? code : null;
}

class VoucherError extends Error {}

/**
 * Guest vouchers (FR-Z4). An admin creates a one-time code for a visitor,
 * choosing which services it opens and for how long. Only an HMAC of the code
 * is stored. Each voucher gets its own guest account, which is INACTIVE for
 * password sign-in (it has no usable password); the visitor gets in only by
 * redeeming the code, which works once and expires on its own.
 */
function createVouchers({ db, config, audit, sessions }) {
  const hashCode = (code) => keyedHash(config.tokenHmacKey, 'voucher', code);

  async function create({ services, hours, label }, ctx) {
    const chosen = [...new Set(Array.isArray(services) ? services : [services])].filter((s) => VOUCHER_SERVICES.includes(s));
    if (chosen.length === 0) throw new VoucherError('Choose at least one service.');
    const h = Number(hours);
    if (!Number.isInteger(h) || h < 1 || h > 24 * 30) throw new VoucherError('Validity must be 1 to 720 hours.');
    const note = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    const code = randomChars(8);
    const tag = randomChars(6);

    return db.transaction(async (trx) => {
      const role = await trx('roles').where({ name: 'guest' }).first('id');
      const [guest] = await trx('users').insert({
        matric_or_staff_id: `GUEST-${tag}`,
        username: `GUEST-${tag}`,
        email: `guest-${tag.toLowerCase()}@guest.invalid`,
        password_hash: `!voucher-only:${crypto.randomBytes(16).toString('base64url')}`, // never a valid bcrypt hash
        role_id: role.id,
        is_active: false, // no password sign-in, ever
        email_verified: true,
      }).returning('id');
      const [row] = await trx('guest_vouchers').insert({
        code_hash: hashCode(code),
        guest_user_id: guest.id,
        services: chosen,
        label: note || null,
        expires_at: trx.raw(`now() + make_interval(hours => ?)`, [h]),
        created_by: ctx.adminId || null,
      }).returning(['id', 'expires_at']);
      await audit.recordCritical(trx, 'voucher_created', {
        userId: guest.id, success: true, details: { actor: ctx.actor, services: chosen.join(','), hours: h },
      }, ctx);
      return { id: row.id, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: row.expires_at, guestId: `GUEST-${tag}`, services: chosen };
    });
  }

  /** Use a code once. Returns { guestUserId, services, expiresAt } or null (wrong, used, revoked or expired). */
  async function redeem(input) {
    const code = normalizeCode(input);
    if (!code) return null;
    const [row] = await db('guest_vouchers')
      .where({ code_hash: hashCode(code) })
      .whereNull('used_at').whereNull('revoked_at')
      .where('expires_at', '>', db.fn.now())
      .update({ used_at: db.fn.now() })
      .returning(['guest_user_id', 'services', 'expires_at']);
    return row ? { guestUserId: row.guest_user_id, services: row.services, expiresAt: row.expires_at } : null;
  }

  /** Revoke a voucher and end its guest session. Returns false if there is no such voucher. */
  async function revoke(id, ctx) {
    const row = await db.transaction(async (trx) => {
      const [v] = await trx('guest_vouchers').where({ id }).whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now() }).returning(['id', 'guest_user_id']);
      if (!v) return null;
      await audit.recordCritical(trx, 'voucher_revoked', { userId: v.guest_user_id, success: true, details: { actor: ctx.actor } }, ctx);
      return v;
    });
    if (!row) return false;
    await sessions.revokeUser(row.guest_user_id, 'voucher_revoked');
    return true;
  }

  async function list() {
    return db('guest_vouchers').join('users', 'users.id', 'guest_vouchers.guest_user_id')
      .orderBy('guest_vouchers.id', 'desc').limit(50)
      .select('guest_vouchers.id', 'users.matric_or_staff_id as guest', 'services', 'label', 'expires_at', 'used_at', 'revoked_at');
  }

  return { create, redeem, revoke, list };
}

module.exports = { createVouchers, normalizeCode, VoucherError, VOUCHER_SERVICES };
