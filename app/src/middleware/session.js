'use strict';

/**
 * Login-once session (FR-P1) and the pre-auth ticket cookie.
 * HttpOnly + SameSite=Strict; Secure and __Host- prefixed when COOKIE_SECURE=true.
 *
 * - pre-auth ticket: password correct, second factor pending (5 min, Redis).
 * - session: signed JWT. scope 'full' = completed sign-in; scope 'enrol' =
 *   admin without TOTP (FR-A13), accepted ONLY on ENROLMENT_ROUTES.
 */

// The only routes an enrolment-only session may use.
const ENROLMENT_ROUTES = Object.freeze([
  'GET /account/security',
  'POST /auth/logout',
  'POST /auth/totp/enrol',
  'POST /auth/totp/enrol/confirm',
]);

// Account-security changes: a session AND a recent sign-in.
const SECURITY_CHANGE_ROUTES = Object.freeze([
  'POST /auth/2fa/email/confirm',
  'POST /auth/2fa/email/enable',
  'POST /auth/password/change',
  'POST /auth/totp/enrol',
  'POST /auth/totp/enrol/confirm',
]);

// Security changes need a sign-in in the last 10 minutes, not just a live session.
const RECENT_SIGN_IN_MIN = 10;

const SESSION_UNAVAILABLE = 'Sign-in checks are unavailable right now. Please try again in a moment.';

function sessionCookies(config) {
  const prefix = config.cookieSecure ? '__Host-' : '';
  const base = { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' };
  const names = {
    preauth: `${prefix}cg.preauth`,
    session: `${prefix}cg.session`,
    queueTicket: `${prefix}cg.wr`, // waiting-room ticket (FR-P2)
    admissionPass: `${prefix}cg.admit`, // permission to start a sign-in
  };
  return {
    names,
    setQueueTicket: (res, ticket) => res.cookie(names.queueTicket, ticket, { ...base, maxAge: 60 * 60 * 1000 }),
    clearQueueTicket: (res) => res.clearCookie(names.queueTicket, base),
    setAdmissionPass: (res, pass) => res.cookie(names.admissionPass, pass, { ...base, maxAge: config.queuePassTtlSec * 1000 }),
    clearAdmissionPass: (res) => res.clearCookie(names.admissionPass, base),
    setPreauth: (res, token) => res.cookie(names.preauth, token, { ...base, maxAge: config.preauthTtlSec * 1000 }),
    clearPreauth: (res) => res.clearCookie(names.preauth, base),
    setSession: (res, { token, maxAgeMs }) => res.cookie(names.session, token, { ...base, maxAge: maxAgeMs }),
    clearSession: (res) => res.clearCookie(names.session, base),
  };
}

/**
 * Accept a request only with a valid, unexpired, unrevoked session token.
 * The check is the signature, the expiry and ONE Redis lookup (denylist); no
 * database read. If Redis is unreachable the request FAILS CLOSED with 503:
 * a revoked token must never be accepted because the denylist could not be read.
 *
 * Sets req.account = { userId, role, scope, jti, issuedAt, expiresAt }.
 * `allowEnrolment` also admits enrolment-only sessions (ENROLMENT_ROUTES only).
 */
function requireSession({ sessions, cookies }, { allowEnrolment = false } = {}) {
  const middleware = async (req, res, next) => {
    const claims = sessions.verify(req.cookies[cookies.names.session]);
    const scopeOk = claims && (claims.scope === 'full' || (allowEnrolment && claims.scope === 'enrol'));
    let revoked = false;
    if (scopeOk) {
      try {
        revoked = await sessions.isRevoked(claims.jti);
      } catch (err) {
        req.log.error({ event: 'session_check_unavailable', err }, 'session denylist unreachable; request refused');
        const unavailable = new Error('session denylist unreachable');
        unavailable.status = 503;
        unavailable.publicMessage = SESSION_UNAVAILABLE;
        return next(unavailable);
      }
    }
    if (!scopeOk || revoked) {
      if (claims && !scopeOk) req.log.info({ event: 'session_scope_refused', userId: claims.userId, scope: claims.scope }, 'session scope not allowed here');
      if (req.cookies[cookies.names.session]) cookies.clearSession(res);
      if (req.method === 'GET') return res.redirect('/login');
      return res.status(401).json({ error: 'Please sign in again.', restart: true });
    }
    req.account = claims;
    return next();
  };
  middleware.requiresSession = true; // lets a test find every route that uses it
  middleware.allowsEnrolment = allowEnrolment;
  return middleware;
}

/** After requireSession: the sign-in must be recent (security changes). */
function requireRecentSignIn({ minutes = RECENT_SIGN_IN_MIN, now = () => Date.now() } = {}) {
  const middleware = (req, res, next) => {
    if (req.account && now() - req.account.issuedAt * 1000 <= minutes * 60 * 1000) return next();
    return res.status(401).json({
      error: `For your security, please sign in again to change these settings (sign-ins older than ${minutes} minutes cannot).`,
      restart: true,
    });
  };
  middleware.requiresRecentSignIn = true;
  return middleware;
}

module.exports = {
  sessionCookies,
  requireSession,
  requireRecentSignIn,
  ENROLMENT_ROUTES,
  SECURITY_CHANGE_ROUTES,
  RECENT_SIGN_IN_MIN,
  SESSION_UNAVAILABLE,
};
