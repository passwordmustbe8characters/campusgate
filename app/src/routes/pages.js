'use strict';

const express = require('express');
const { getPolicy } = require('../policies/policyRepo');
const { describePolicy } = require('../services/passwordPolicy');

const SECOND_FACTOR_METHODS = ['email', 'totp'];

/**
 * Server-rendered pages. Forms submit to the JSON API via public/js/forms.js.
 * Plain and functional on purpose; a UI polish pass comes later.
 */
function pagesRouter({ db, csrf, requireAccount, settingsService }) {
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

  // Second step of sign-in. The method only chooses which form to show; the
  // pre-auth ticket decides what is actually accepted.
  router.get('/verify', csrf.ensurePreSession, (req, res) => {
    const method = SECOND_FACTOR_METHODS.includes(req.query.method) ? req.query.method : 'email';
    res.render('verify', { title: 'Two-step sign-in', csrfToken: csrf.generateCsrfToken(req, res), method });
  });

  // Interim (Phase 2): reached with the account ticket. TODO(Phase 4): use the session.
  router.get('/account/security', csrf.ensurePreSession, requireAccount, async (req, res) => {
    const [status, policy] = await Promise.all([settingsService.status(req.account.userId), getPolicy(db)]);
    res.render('account-security', {
      title: 'Security settings',
      csrfToken: csrf.generateCsrfToken(req, res),
      status,
      passwordRules: describePolicy(policy),
    });
  });

  return router;
}

module.exports = { pagesRouter };
