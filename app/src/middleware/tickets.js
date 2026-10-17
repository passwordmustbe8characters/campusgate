'use strict';

/**
 * Cookies for the two Redis tickets. HttpOnly + SameSite=Strict, Secure and
 * __Host- prefixed when COOKIE_SECURE=true.
 *
 * - pre-auth ticket: password correct, second factor pending (5 min).
 * - account ticket: INTERIM (Phase 2 only). Proves a completed sign-in and is
 *   accepted ONLY by the security-settings routes in ACCOUNT_TICKET_ROUTES.
 *   TODO(Phase 4): delete the account ticket and use the JWT session instead.
 */
const ACCOUNT_TICKET_ROUTES = Object.freeze([
  'GET /account/security',
  'POST /auth/2fa/email/enable',
  'POST /auth/2fa/email/confirm',
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

/** The ONE middleware that accepts the interim account ticket. Mount it only on ACCOUNT_TICKET_ROUTES. */
function requireAccountTicket({ accountTickets, cookies }) {
  const middleware = async (req, res, next) => {
    const data = await accountTickets.get(req.cookies[cookies.names.account]);
    if (!data) {
      if (req.method === 'GET') return res.redirect('/login');
      return res.status(401).json({ error: 'Please sign in again.', restart: true });
    }
    req.account = { userId: Number(data.userId), role: data.role };
    return next();
  };
  middleware.acceptsAccountTicket = true; // lets a test find every route that uses it
  return middleware;
}

module.exports = { ticketCookies, requireAccountTicket, ACCOUNT_TICKET_ROUTES };
