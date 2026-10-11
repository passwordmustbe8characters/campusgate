'use strict';

const express = require('express');
const { getPolicy } = require('../policies/policyRepo');
const { describePolicy } = require('../services/passwordPolicy');

/** Server-rendered pages. Forms submit to the JSON API via public/js/forms.js. */
function pagesRouter({ db, csrf }) {
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

  return router;
}

module.exports = { pagesRouter };
