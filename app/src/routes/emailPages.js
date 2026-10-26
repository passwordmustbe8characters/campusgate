'use strict';

const express = require('express');

/**
 * Page behind the emailed verification link (FR-A2). The token arrives after
 * "#" (never sent to the server); forms.js copies it into the form, which
 * posts it to POST /auth/verify-email.
 */
function emailPagesRouter({ csrf }) {
  const router = express.Router();
  router.get('/verify-email', csrf.ensurePreSession, (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.render('verify-email', { title: 'Confirm your email', csrfToken: csrf.generateCsrfToken(req, res) });
  });
  return router;
}

module.exports = { emailPagesRouter };
