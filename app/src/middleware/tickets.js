'use strict';

/**
 * Cookies for the two Redis tickets. HttpOnly + SameSite=Strict, Secure and
 * __Host- prefixed when COOKIE_SECURE=true.
 *
 * - pre-auth ticket: password correct, second factor pending (5 min).
 * - account ticket: INTERIM (Phase 2 only). Proves a sign-in and is accepted
 *   ONLY by the security-settings routes listed below.
 *   scope 'full'   : completed sign-in
 *   scope 'enrol'  : admin without TOTP (FR-A13); may only enrol TOTP
 *   TODO(Phase 4): delete the account ticket and use the JWT session instead.
 */
const ACCOUNT_TICKET_ROUTES = Object.freeze([
  'GET /account/security',
  'POST /auth/2fa/email/enable',
  'POST /auth/2fa/email/confirm',
  'POST /auth/totp/enrol',
  'POST /auth/totp/enrol/confirm',
  'POST /auth/password/change',
]);

// Routes an enrolment-only ticket may use (subset of the above).
const ENROLMENT_ROUTES = Object.freeze([
  'GET /account/security',
  'POST /auth/totp/enrol',
  'POST /auth/totp/enrol/confirm',
]);

function ticketCookies(config) {
  const prefix = config.cookieSecure ? '__Host-' : '';
  const base = { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' };
  const names = { preauth: `${prefix}cg.preauth`, account: `${prefix}cg.acct` };
  return {
    names,
    setPreauth: (res, token) => res.cookie(names.preauth, token, { ...base, maxAge: config.preauthTtlSec * 1000 }),
    clearPreauth: (res) => res.clearCookie(names.preauth, base),
    setAccount: (res, token) => res.cookie(names.account, token, { ...base, maxAge: config.accountTicketTtlMin * 60000 }),
    clearAccount: (res) => res.clearCookie(names.account, base),
  };
}

/**
 * The ONLY middleware that accepts the interim account ticket. Mount it only
 * on ACCOUNT_TICKET_ROUTES. `allowEnrolment` also admits enrolment-only tickets
 * (use it only on ENROLMENT_ROUTES).
 */
function requireAccountTicket({ accountTickets, cookies }, { allowEnrolment = false } = {}) {
  const middleware = async (req, res, next) => {
    const data = await accountTickets.get(req.cookies[cookies.names.account]);
    const scopeOk = data && (data.scope === 'full' || (allowEnrolment && data.scope === 'enrol'));
    if (!scopeOk) {
      if (req.method === 'GET') return res.redirect('/login');
      return res.status(401).json({ error: 'Please sign in again.', restart: true });
    }
    req.account = { userId: Number(data.userId), role: data.role, scope: data.scope };
    return next();
  };
  middleware.acceptsAccountTicket = true; // lets a test find every route that uses it
  middleware.allowsEnrolment = allowEnrolment;
  return middleware;
}

module.exports = { ticketCookies, requireAccountTicket, ACCOUNT_TICKET_ROUTES, ENROLMENT_ROUTES };
