'use strict';

const {
  keyedHash, safeEqual, randomToken, randomDigits, encryptForUser, decryptForUser,
} = require('../../app/src/services/secrets');

const KEY = Buffer.alloc(32, 5);

describe('secrets helpers', () => {
  test('keyed hash depends on key, domain and value', () => {
    const base = keyedHash(KEY, 'otp', '123456');
    expect(base).toBe(keyedHash(KEY, 'otp', '123456'));
    expect(base).not.toBe(keyedHash(KEY, 'backup', '123456'));
    expect(base).not.toBe(keyedHash(Buffer.alloc(32, 6), 'otp', '123456'));
    expect(base).not.toContain('123456');
  });

  test('safeEqual compares strings in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  test('random token is 256-bit base64url by default', () => {
    const token = randomToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken()).not.toBe(token);
  });

  test('random digits are always 6 digits and cover the range', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) {
      const code = randomDigits(6);
      expect(code).toMatch(/^\d{6}$/);
      seen.add(code[0]);
    }
    expect(seen.size).toBe(10); // leading zeros happen
  });

  test('encryption round-trips and is bound to the user id', () => {
    const stored = encryptForUser(KEY, 42, 'JBSWY3DPEHPK3PXP');
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptForUser(KEY, 42, stored)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptForUser(KEY, 43, stored)).toThrow(); // copied onto another account
    expect(() => decryptForUser(Buffer.alloc(32, 6), 42, stored)).toThrow(); // wrong / changed key
  });

  test('encrypting the same secret twice gives different ciphertexts (random IV)', () => {
    expect(encryptForUser(KEY, 1, 'S')).not.toBe(encryptForUser(KEY, 1, 'S'));
  });

  test('tampered ciphertext is rejected', () => {
    const parts = encryptForUser(KEY, 1, 'SECRET').split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptForUser(KEY, 1, parts.join(':'))).toThrow();
  });
});
