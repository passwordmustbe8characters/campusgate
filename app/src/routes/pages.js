'use strict';

const express = require('express');
const { getPolicy } = require('../policies/policyRepo');
const { describePolicy } = require('../services/passwordPolicy');

const SECOND_FACTOR_METHODS = ['email', 'totp'];

/**
 * Server-rendered pages. Forms submit to the JSON API via public/js/forms.js.
 * Plain and functional on purpose; a UI polish pass comes later.
 */
function pagesRouter({ db, csrf, requireAccountOrEnrolment, settingsService }) {
  const router = express.Router();

  router.get('/', (req, res) => res.redirect('/login'));

  router.get('/login', csrf.ensurePreSession, (req, res) => {
    res.render('login', {
      title: 'Sign in',
      csrfToken: csrf.generateCsrfToken(req, res),
      registered: req.query.registered === '1',
    });
  });

  router.get('/register', csrf.ensurePreSession, async (req, res) => {
    const policy = await getPolicy(db);
    res.render('register', {
      title: 'Create account',
      csrfToken: csrf.generateCsrfToken(req, res),
      passwordRules: describePolicy(policy),
    });
  });

  router.get('/forgot-password', csrf.ensurePreSession, (req, res) => {
    res.render('forgot-password', { title: 'Forgot password', csrfToken: csrf.generateCsrfToken(req, res) });
  });

  // The token arrives in the URL fragment (#token=...), which the browser never
  // sends to the server; forms.js copies it into the form.
  router.get('/reset-password', csrf.ensurePreSession, async (req, res) => {
    const policy = await getPolicy(db);
    res.set('Referrer-Policy', 'no-referrer');
    res.render('reset-password', {
      title: 'Choose a new password',
      csrfToken: csrf.generateCsrfToken(req, res),
      passwordRules: describePolicy(policy),
    });
  });

  // Second step of sign-in. The method only chooses which form to show; the
  // pre-auth ticket decides what is actually accepted.
  router.get('/verify', csrf.ensurePreSession, (req, res) => {
    const method = SECOND_FACTOR_METHODS.includes(req.query.method) ? req.query.method : 'email';
    res.render('verify', { title: 'Two-step sign-in', csrfToken: csrf.generateCsrfToken(req, res), method });
  });

  // Interim (Phase 2): reached with the account ticket. TODO(Phase 4): use the session.
  router.get('/account/security', csrf.ensurePreSession, requireAccountOrEnrolment, async (req, res) => {
    const [status, policy] = await Promise.all([settingsService.status(req.account.userId), getPolicy(db)]);
    res.render('account-security', {
      title: 'Security settings',
      csrfToken: csrf.generateCsrfToken(req, res),
      status,
      enrolmentOnly: req.account.scope === 'enrol',
      passwordRules: describePolicy(policy),
    });
  });

  return router;
}

module.exports = { pagesRouter };
