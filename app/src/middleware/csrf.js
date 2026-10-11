'use strict';

const { randomBytes } = require('node:crypto');
const { doubleCsrf } = require('csrf-csrf');

/**
 * CSRF protection (NFR-2) with csrf-csrf's double-submit cookie pattern.
 *
 * csrf-csrf binds each token to a per-visitor identifier. Before login there
 * is no session yet, so every visitor gets a random, HttpOnly, SameSite=Strict
 * "pre-session" cookie, and tokens are bound to it. This also blocks login CSRF.
 * TODO(Phase 4): bind tokens to the session (JWT jti) after login.
 *
 * The __Host- prefix requires Secure cookies (HTTPS, Phase 9), so it is only
 * used when COOKIE_SECURE=true.
 */
function createCsrf(config) {
  const prefix = config.cookieSecure ? '__Host-' : '';
  const preSessionCookie = `${prefix}cg.presession`;
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' };

  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => config.csrfSecret,
    getSessionIdentifier: (req) => req.cookies[preSessionCookie] || '',
    cookieName: `${prefix}cg.csrf`,
    cookieOptions,
    getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
  });

  /** Give the visitor a pre-session id if they have none (pages only, not /health). */
  function ensurePreSession(req, res, next) {
    if (!req.cookies[preSessionCookie]) {
      const id = randomBytes(32).toString('base64url');
      res.cookie(preSessionCookie, id, cookieOptions);
      req.cookies[preSessionCookie] = id;
    }
    next();
  }

  return { ensurePreSession, doubleCsrfProtection, generateCsrfToken };
}

module.exports = { createCsrf };
