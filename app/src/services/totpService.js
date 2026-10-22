'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { generateSecret, generateURI, verify } = require('otplib');
const { keyedHash, encryptForUser, decryptForUser } = require('./secrets');

const ISSUER = 'CampusGate';
const DRIFT_SEC = 30; // one 30 s step either side
const PENDING_TTL_SEC = 600; // finish enrolment within 10 minutes

// Backup codes: 10 characters from an alphabet without look-alikes (no 0/O, 1/I/L, U),
// 30 symbols -> about 49 bits each. Shown as XXXXX-XXXXX.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const BACKUP_COUNT = 8;
const BACKUP_LENGTH = 10;

function generateBackupCode() {
  let code = '';
  for (let i = 0; i < BACKUP_LENGTH; i += 1) code += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Accept "abcde-fghjk", "ABCDE FGHJK", "abcdefghjk"; return the 10-char canonical form or null. */
function normalizeBackupCode(input) {
  const code = String(input || '').toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== BACKUP_LENGTH) return null;
  for (const ch of code) if (!BACKUP_ALPHABET.includes(ch)) return null;
  return code;
}

class EnrolmentError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'EnrolmentError';
    this.status = status;
    this.publicMessage = message;
  }
}

/**
 * TOTP (FR-A8): RFC 6238, 6 digits, 30 s, +/-1 step of drift. Secrets are
 * AES-256-GCM encrypted with TOTP_ENC_KEY, bound to the user id. Replay is
 * blocked by storing the last accepted time step (totp_last_step) and
 * accepting only later steps, atomically.
 */
function createTotpService({ db, redis, encKey, hmacKey, clock = { now: () => Date.now() } }) {
  const pendingKey = (userId) => `cg:totp-pending:${userId}`;
  // The clock is injectable so tests can pin time and never straddle a 30 s step.
  const epoch = () => Math.floor(clock.now() / 1000);
  const hashBackup = (userId, code) => keyedHash(hmacKey, 'backup', `${userId}:${code}`);

  /** Start enrolment: new secret kept (encrypted) in Redis until confirmed. */
  // Enrolment is refused only when TOTP is already on; an email-2FA account may switch to TOTP.
  const hasTotp = (account) => account.two_factor_enabled && account.two_factor_method === 'totp';

  async function startEnrolment(account) {
    if (hasTotp(account)) throw new EnrolmentError(409, 'Authenticator app is already on.');
    const secret = generateSecret(); // 20 random bytes, base32
    await redis.set(pendingKey(account.id), encryptForUser(encKey, account.id, secret), 'EX', PENDING_TTL_SEC);
    const uri = generateURI({ issuer: ISSUER, label: account.matric_or_staff_id, secret });
    return { secret, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
  }

  /** Confirm with one valid code: store the secret, turn 2FA on, return 8 backup codes (shown once). */
  /** `beforeCommit(trx)` runs inside the enrolment transaction (used for the fail-closed audit event). */
  async function confirmEnrolment(account, code, { beforeCommit } = {}) {
    if (hasTotp(account)) throw new EnrolmentError(409, 'Authenticator app is already on.');
    const pending = await redis.get(pendingKey(account.id));
    if (!pending) throw new EnrolmentError(400, 'Set-up expired. Start again.');
    const secret = decryptForUser(encKey, account.id, pending);

    const result = await verify({ secret, token: code, epoch: epoch(), epochTolerance: DRIFT_SEC });
    if (!result.valid) throw new EnrolmentError(400, 'That code did not match. Check the time on your phone and try again.');

    const codes = Array.from({ length: BACKUP_COUNT }, generateBackupCode);
    await db.transaction(async (trx) => {
      const updated = await trx('users')
        .where({ id: account.id })
        .andWhere((q) => q.whereNull('two_factor_method').orWhere('two_factor_method', '<>', 'totp'))
        .update({
          totp_secret_enc: encryptForUser(encKey, account.id, secret),
          two_factor_enabled: true,
          two_factor_method: 'totp',
          totp_last_step: result.timeStep, // the confirming code cannot be replayed at sign-in
        });
      if (updated !== 1) throw new EnrolmentError(409, 'Authenticator app is already on.');
      await trx('totp_backup_codes').where({ user_id: account.id }).del();
      await trx('totp_backup_codes').insert(
        codes.map((c) => ({ user_id: account.id, code_hash: hashBackup(account.id, normalizeBackupCode(c)) })),
      );
      if (beforeCommit) await beforeCommit(trx);
    });
    await redis.del(pendingKey(account.id));
    return { backupCodes: codes };
  }

  /** Sign-in check. Returns 'ok' or 'wrong' (wrong code, or a replay of an already-used step). */
  async function verifyLogin(account, code) {
    // Throws if TOTP_ENC_KEY changed or the row was tampered with: a server error, never counted.
    const secret = decryptForUser(encKey, account.id, account.totp_secret_enc);
    const lastStep = account.totp_last_step === null ? undefined : Number(account.totp_last_step);
    const result = await verify({ secret, token: code, epoch: epoch(), epochTolerance: DRIFT_SEC, afterTimeStep: lastStep });
    if (!result.valid) return 'wrong';

    // Atomic replay guard: only one request can move the step forward.
    const moved = await db('users')
      .where({ id: account.id })
      .andWhere((q) => q.whereNull('totp_last_step').orWhere('totp_last_step', '<', result.timeStep))
      .update({ totp_last_step: result.timeStep });
    return moved === 1 ? 'ok' : 'wrong';
  }

  /** Backup code: single use, atomically. */
  async function verifyBackupCode(account, input) {
    const code = normalizeBackupCode(input);
    if (!code) return 'wrong';
    const used = await db('totp_backup_codes')
      .where({ user_id: account.id, code_hash: hashBackup(account.id, code), used: false })
      .update({ used: true });
    return used === 1 ? 'ok' : 'wrong';
  }

  return { startEnrolment, confirmEnrolment, verifyLogin, verifyBackupCode };
}

module.exports = { createTotpService, generateBackupCode, normalizeBackupCode, EnrolmentError, BACKUP_ALPHABET };
