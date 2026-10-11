'use strict';

const fs = require('node:fs');
const path = require('node:path');

// bcrypt only uses the first 72 bytes of a password. Longer passwords are
// rejected instead of being silently truncated.
const BCRYPT_MAX_BYTES = 72;

const BLOCKLIST = new Set(
  fs
    .readFileSync(path.join(__dirname, '../policies/common-passwords.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#')),
);

/**
 * Check a password against the active policy row (FR-A3).
 * Returns a list of human-readable problems; an empty list means acceptable.
 */
function checkPassword(password, policy) {
  const problems = [];
  if (typeof password !== 'string') return ['Password is required.'];

  if ([...password].length < policy.min_length) {
    problems.push(`Use at least ${policy.min_length} characters.`);
  }
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    problems.push(`Use at most ${BCRYPT_MAX_BYTES} bytes (about ${BCRYPT_MAX_BYTES} plain characters).`);
  }
  if (policy.require_upper && !/\p{Lu}/u.test(password)) {
    problems.push('Include at least one uppercase letter.');
  }
  if (policy.require_special && !/[^\p{L}\p{N}]/u.test(password)) {
    problems.push('Include at least one special character (for example ! @ # $).');
  }
  if (BLOCKLIST.has(password.toLowerCase())) {
    problems.push('This password is too common. Choose a less predictable one.');
  }
  return problems;
}

/** Plain-language rules for the registration page. */
function describePolicy(policy) {
  const rules = [`At least ${policy.min_length} characters`];
  if (policy.require_upper) rules.push('At least one uppercase letter');
  if (policy.require_special) rules.push('At least one special character');
  rules.push('Not a common password');
  return rules;
}

module.exports = { checkPassword, describePolicy, BCRYPT_MAX_BYTES, BLOCKLIST };
