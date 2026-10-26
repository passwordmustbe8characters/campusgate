'use strict';

const express = require('express');
const { auditContext } = require('../audit/audit');

const INVALID = 'This code is not valid. It may be mistyped, already used, cancelled or expired.';

/**
 * Guest sign-in with a voucher code (FR-Z4).
 *   GET  /voucher       the page
 *   POST /auth/voucher  { code } -> a short guest session limited to the voucher's services
 * Rate limited per IP; every outcome looks the same except success.
 */
function voucherRouter({ csrf, rateLimiter, vouchers, sessions, cookies, getPolicy, audit }) {
  const router = express.Router();

  router.get('/voucher', csrf.ensurePreSession, (req, res) => {
    res.render('voucher', { title: 'Guest access', csrfToken: csrf.generateCsrfToken(req, res) });
  });

  router.post('/auth/voucher', rateLimiter.limit('voucher', { byAccount: false }), async (req, res) => {
    const ctx = auditContext(req);
    const v = await vouchers.redeem(req.body.code);
    if (!v) {
      await audit.record('login_failure', { userId: null, success: false, details: { reason: 'bad_voucher', stage: 'voucher' } }, ctx);
      return res.status(401).json({ error: INVALID });
    }
    const policy = await getPolicy();
    const minutesLeft = Math.floor((new Date(v.expiresAt).getTime() - Date.now()) / 60000);
    const ttlMin = Math.max(1, Math.min(policy.session_timeout_min, minutesLeft));
    const session = await sessions.issue({
      userId: v.guestUserId, role: 'guest', ttlMin, ip: req.ip, userAgent: req.get('user-agent'), services: v.services,
    });
    cookies.setSession(res, session);
    await audit.record('voucher_redeemed', { userId: v.guestUserId, success: true, details: { services: v.services.join(',') } }, ctx);
    return res.status(200).json({ status: 'signed_in', message: 'Welcome. Your guest access is ready.', role: 'guest' });
  });

  return router;
}

module.exports = { voucherRouter };
