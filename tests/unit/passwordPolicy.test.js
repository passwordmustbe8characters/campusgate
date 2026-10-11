'use strict';

const { checkPassword, describePolicy, BLOCKLIST } = require('../../app/src/services/passwordPolicy');

const POLICY = { min_length: 8, require_upper: true, require_special: true };

describe('password policy (FR-A3)', () => {
  test('accepts a password that meets every rule', () => {
    expect(checkPassword('Kettle-Mango-42', POLICY)).toEqual([]);
  });

  test('enforces minimum length from the policy row', () => {
    expect(checkPassword('Ab!1', POLICY)).toContain('Use at least 8 characters.');
    expect(checkPassword('Abcdefg!xyz', { ...POLICY, min_length: 12 })).toContain('Use at least 12 characters.');
  });

  test('counts characters, not bytes, for the minimum length', () => {
    // 8 characters, but more than 8 bytes in UTF-8.
    expect(checkPassword('Éééééé!x', POLICY)).not.toContain('Use at least 8 characters.');
  });

  test('requires an uppercase letter only when the policy says so', () => {
    expect(checkPassword('kettle-mango-42', POLICY)).toContain('Include at least one uppercase letter.');
    expect(checkPassword('kettle-mango-42', { ...POLICY, require_upper: false })).toEqual([]);
  });

  test('requires a special character only when the policy says so', () => {
    expect(checkPassword('KettleMango42', POLICY)).toContain(
      'Include at least one special character (for example ! @ # $).',
    );
    expect(checkPassword('KettleMango42', { ...POLICY, require_special: false })).toEqual([]);
  });

  test('rejects passwords over 72 bytes instead of letting bcrypt truncate them', () => {
    expect(checkPassword(`A!${'a'.repeat(70)}`, POLICY)).toEqual([]); // exactly 72 bytes
    expect(checkPassword(`A!${'a'.repeat(71)}`, POLICY).join(' ')).toMatch(/at most 72 bytes/);
    // 36 two-byte characters = 72 bytes; one more pushes it over.
    expect(checkPassword(`A!${'é'.repeat(36)}`, POLICY).join(' ')).toMatch(/at most 72 bytes/);
  });

  test.each(['Password@123', 'P@ssw0rd', 'WELCOME@123', 'Nigeria@123', 'Student@123'])(
    'blocks the common password %s even though it meets the other rules',
    (password) => {
      expect(checkPassword(password, POLICY)).toEqual([
        'This password is too common. Choose a less predictable one.',
      ]);
    },
  );

  test('blocklist is loaded and ignores comment lines', () => {
    expect(BLOCKLIST.size).toBeGreaterThan(100);
    expect([...BLOCKLIST].some((entry) => entry.startsWith('#'))).toBe(false);
  });

  test('reports every failing rule at once', () => {
    expect(checkPassword('abc', POLICY)).toHaveLength(3);
  });

  test('describes the active rules for the registration page', () => {
    expect(describePolicy({ ...POLICY, require_special: false })).toEqual([
      'At least 8 characters',
      'At least one uppercase letter',
      'Not a common password',
    ]);
  });
});
