'use strict';

const crypto = require('node:crypto');

/**
 * Keyed hash for high-entropy or short-lived secrets (OTPs, backup codes,
 * reset tokens, ticket ids). The domain ("otp", "backup", "reset", ...) keeps
 * one use from ever matching another. Output is base64url.
 */
function keyedHash(key, domain, value) {
  return crypto.createHmac('sha256', key).update(`${domain}:${value}`).digest('base64url');
}

/** Constant-time string comparison (false for different lengths). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** URL-safe random token; 32 bytes = 256 bits by default. */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** n random decimal digits from a CSPRNG, e.g. "042917". */
function randomDigits(n = 6) {
  return String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
}

// AES-256-GCM, stored as "v1:<iv>:<tag>:<ciphertext>" (base64url parts).
// The user id is authenticated data, so a ciphertext copied onto another
// account fails to decrypt.
const ENC_VERSION = 'v1';

function encryptForUser(key, userId, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`user:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [ENC_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join(':');
}

function decryptForUser(key, userId, stored) {
  const [version, iv, tag, ciphertext] = String(stored).split(':');
  if (version !== ENC_VERSION || !iv || !tag || !ciphertext) throw new Error('unsupported ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(`user:${userId}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { keyedHash, safeEqual, randomToken, randomDigits, encryptForUser, decryptForUser };
