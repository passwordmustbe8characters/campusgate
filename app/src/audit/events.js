'use strict';

const { randomUUID } = require('node:crypto');
const { keyedHash } = require('../services/secrets');

/**
 * Every audit event type and the ONLY detail fields it may carry (FR-L1).
 * Values must be short plain strings, integers or booleans. Anything else is
 * rejected, so a password, OTP, token, secret, backup code or email address
 * cannot reach the audit log by accident.
 *
 * `critical: true` = account-security change or admin action: FAIL CLOSED.
 * It is written inside the same database transaction as the change, so the
 * change and its audit row commit together or not at all.
 * Everything else is high volume: FAIL OPEN (the action proceeds; the event
 * goes to a marked fallback log line and an alert counter).
 */
const EVENT_TYPES = Object.freeze({
  // Accounts and sign-in (fail open)
  register: { details: ['reason'] },
  login_success: { details: ['method'] },
  login_failure: { details: ['reason', 'stage', 'method', 'failedAttempts', 'riskScore', 'signals'] },
  lockout: { details: ['failedAttempts', 'lockedUntil', 'stage'] },
  second_factor_required: { details: ['method', 'reason', 'riskScore', 'signals'] },
  email_verified: { details: [] },
  new_device_alert: { details: [] },
  admin_enrolment_required: { details: [] },
  // One-time codes (fail open)
  otp_sent: { details: ['purpose', 'channel'] },
  otp_delivery_failed: { details: ['purpose', 'channel'] },
  otp_verified: { details: ['purpose'] },
  otp_failed: { details: ['purpose', 'reason'] },
  backup_code_used: { details: [] },
  totp_enrolment_started: { details: [] },
  // Password recovery requests (fail open)
  reset_requested: { details: ['outcome'] },
  reset_email_failed: { details: [] },
  password_change_failed: { details: ['reason'] },
  // Sessions (fail open): sign-out, sign-out everywhere, revocation after a security change
  logout: { details: [] },
  logout_all: { details: ['count'] },
  sessions_revoked: { details: ['reason', 'count', 'actor'] },
  // Account-security changes (fail closed)
  two_factor_enabled: { details: ['method'], critical: true },
  password_reset: { details: [], critical: true },
  password_changed: { details: [], critical: true },
  // Admin actions (fail closed)
  admin_unlock: { details: ['actor'], critical: true },
  admin_reset_2fa: { details: ['actor', 'backupCodesRemoved'], critical: true },
  admin_user_status: { details: ['actor', 'active'], critical: true },
  policy_changed: { details: ['actor', 'fields'], critical: true },
  role_changed: { details: ['actor', 'from', 'to'], critical: true },
  permission_changed: { details: ['actor', 'action', 'role', 'service'], critical: true },
  audit_exported: { details: ['actor', 'rows', 'filters'], critical: true },
  audit_verified: { details: ['actor', 'ok', 'checked', 'reason'], critical: true },
  audit_fallback_imported: { details: ['actor', 'imported', 'skipped'], critical: true },
});

const SAFE_STRING = /^[A-Za-z0-9 _.,:+\-=/]{0,128}$/;

class AuditEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditEventError';
  }
}

function checkDetails(type, details) {
  const allowed = EVENT_TYPES[type].details;
  const out = {};
  for (const [k, v] of Object.entries(details || {})) {
    if (v === undefined || v === null) continue;
    if (!allowed.includes(k)) throw new AuditEventError(`audit event "${type}" may not carry "${k}"`);
    const ok =
      typeof v === 'boolean'
      || (typeof v === 'number' && Number.isSafeInteger(v))
      || (typeof v === 'string' && SAFE_STRING.test(v));
    if (!ok) throw new AuditEventError(`audit event "${type}" field "${k}" has a value that is not allowed`);
    out[k] = v;
  }
  return out;
}

/** Normalized identifier -> keyed hash (lets attempts on one account be correlated without storing what was typed). */
function subjectHash(key, subject) {
  if (subject === undefined || subject === null || subject === '') return null;
  const s = String(subject).trim();
  const normalized = s.includes('@') ? s.toLowerCase() : s.toUpperCase();
  return keyedHash(key, 'audit-subject', normalized);
}

/**
 * Build a complete event. ctx = { ip, userAgent, actor? } (request context).
 * Throws AuditEventError for an unknown type or a field that is not whitelisted.
 */
function buildEvent(type, { userId = null, subject = null, success, details = {} } = {}, ctx = {}, subjectKey) {
  if (!EVENT_TYPES[type]) throw new AuditEventError(`unknown audit event type "${type}"`);
  if (typeof success !== 'boolean') throw new AuditEventError(`audit event "${type}" needs success true/false`);
  return {
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    event_type: type,
    user_id: userId === null || userId === undefined ? null : Number(userId),
    subject_hash: subjectKey ? subjectHash(subjectKey, subject) : null,
    ip: ctx.ip ? String(ctx.ip).slice(0, 64) : null,
    user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 256) : null,
    success,
    details: checkDetails(type, details),
  };
}

const isCritical = (type) => Boolean(EVENT_TYPES[type] && EVENT_TYPES[type].critical);

module.exports = { buildEvent, isCritical, subjectHash, EVENT_TYPES, AuditEventError };
