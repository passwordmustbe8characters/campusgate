'use strict';

const { generateBackupCode, normalizeBackupCode, BACKUP_ALPHABET } = require('../../app/src/services/totpService');

describe('backup codes (FR-A8)', () => {
  test('format XXXXX-XXXXX from an alphabet without look-alike characters', () => {
    for (let i = 0; i < 200; i += 1) expect(generateBackupCode()).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/);
    expect(BACKUP_ALPHABET).not.toMatch(/[01ILOU]/);
  });

  test('high entropy: about 49 bits per code, no repeats in a large sample', () => {
    expect(10 * Math.log2(BACKUP_ALPHABET.length)).toBeGreaterThan(48);
    const sample = new Set(Array.from({ length: 5000 }, generateBackupCode));
    expect(sample.size).toBe(5000);
  });

  test('input is normalized: case, dash and spaces do not matter', () => {
    expect(normalizeBackupCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeBackupCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
    expect(normalizeBackupCode('abcdefghjk')).toBe('ABCDEFGHJK');
  });

  test.each(['', 'ABCDE', 'ABCDE-FGHJKL', 'ABCDE-FGHJ0', 'ABCDE-FGHJI', null, undefined])('rejects %p', (input) => {
    expect(normalizeBackupCode(input)).toBeNull();
  });
});
