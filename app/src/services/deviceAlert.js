'use strict';

const { safeError } = require('./metrics');
const { createBackgroundWork } = require('./backgroundWork');

/** A short, readable device description from a user agent (no full string in the email). */
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  return `${browser} on ${os}`;
}

/**
 * New-device alert (FR-A12). After a completed sign-in from a browser (user
 * agent) that has not signed in to the account in the last 30 days, email the
 * owner. Checked BEFORE the new session is recorded. The very first sign-in of
 * an account (no history) sends nothing. Sent in the background; failures are
 * logged and counted, never shown to the user.
 */
function createDeviceAlert({ db, delivery, metrics, logger, audit, now = () => new Date() }) {
  const work = createBackgroundWork();

  async function isNewDevice(userId, userAgent) {
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, 256) : null;
    const history = await db('sessions').where({ user_id: userId })
      .where('created_at', '>', db.raw("now() - interval '30 days'"))
      .select('user_agent').limit(500);
    return history.length > 0 && !history.some((h) => h.user_agent === ua);
  }

  /** Call before issuing the session. Returns true when an alert was queued. */
  async function checkAndNotify(userId, { ip, userAgent }, ctx = { log: logger }) {
    if (!(await isNewDevice(userId, userAgent))) return false;
    const account = await db('users').where({ id: userId }).first('email', 'matric_or_staff_id');
    const when = now().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
    work.track(delivery.send({
      email: account.email,
      matric: account.matric_or_staff_id,
      subject: 'New sign-in to your CampusGate account',
      text:
        `Your CampusGate account (${account.matric_or_staff_id}) was just signed in to from a new device:\n\n` +
        `  Device: ${describeDevice(userAgent)}\n  IP address: ${ip || 'unknown'}\n  Time: ${when} (Lagos)\n\n` +
        'If this was you, no action is needed. If not, change your password now and use "Sign out everywhere".',
    }).then(
      () => audit.record('new_device_alert', { userId, success: true }, ctx),
      async (err) => {
        await metrics.incr('device_alert_failures');
        ctx.log.error({ event: 'device_alert_failed', userId, error: safeError(err) }, 'new-device email failed');
      },
    ));
    return true;
  }

  return { checkAndNotify, isNewDevice, idle: work.idle };
}

module.exports = { createDeviceAlert, describeDevice };
