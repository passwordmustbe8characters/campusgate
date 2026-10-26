'use strict';

const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { BCRYPT_MAX_BYTES } = require('../services/passwordPolicy');

// Raw size cap before anything else touches the value.
const MAX_PASSWORD_CHARS = 256;

const passwordField = (name) =>
  body(name)
    .isString().withMessage('Password is required.')
    .bail()
    .notEmpty().withMessage('Password is required.')
    .bail()
    .isLength({ max: MAX_PASSWORD_CHARS }).withMessage('Password is too long.');

const registerRules = [
  body('matricNo')
    .isString().withMessage('Matric number is required.')
    .bail()
    .trim()
    .notEmpty().withMessage('Matric number is required.')
    .bail()
    .isLength({ max: 32 }).withMessage('Matric number is too long.')
    .bail()
    .matches(/^[A-Za-z0-9/-]+$/).withMessage('Use only letters, digits, "/" and "-".'),
  body('email')
    .isString().withMessage('Email is required.')
    .bail()
    .trim()
    .isLength({ max: 254 }).withMessage('Email is too long.')
    .bail()
    .isEmail().withMessage('Enter a valid email address.'),
  passwordField('password'),
  body('consent')
    .custom((value) => value === true || value === 'true' || value === 'on')
    .withMessage('Please confirm you have read the privacy notice.'),
];

const loginRules = [
  body('identifier')
    .isString().withMessage('Enter your matric/staff ID or email.')
    .bail()
    .trim()
    .notEmpty().withMessage('Enter your matric/staff ID or email.')
    .bail()
    .isLength({ max: 254 }).withMessage('ID or email is too long.'),
  passwordField('password')
    .bail()
    // A registered password is never longer than this, and bcrypt would ignore the rest.
    .custom((value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES)
    .withMessage('Password is too long.'),
];

// otplib throws on anything that is not exactly 6 digits, so check the shape first.
const sixDigitCode = (name = 'code') =>
  body(name)
    .isString().withMessage('Enter the 6-digit code.')
    .bail()
    .trim()
    .matches(/^\d{6}$/).withMessage('Enter the 6-digit code.');

const forgotRules = [
  body('email')
    .isString().withMessage('Enter your email address.')
    .bail()
    .trim()
    .isLength({ max: 254 }).withMessage('Email is too long.')
    .bail()
    .isEmail().withMessage('Enter a valid email address.'),
];

const resetRules = [
  body('token').isString().withMessage('This reset link is invalid.').bail().isLength({ max: 64 }).withMessage('This reset link is invalid.'),
  passwordField('newPassword'),
];

const changeRules = [passwordField('currentPassword'), passwordField('newPassword')];

/**
 * @param controller                  auth controller (login, second factor, sign-out)
 * @param settings                    security-settings controller
 * @param requireSignedIn             session check (full sign-in only)
 * @param requireSignedInOrEnrolment  session check that also admits an enrolment-only session (ENROLMENT_ROUTES)
 * @param recent                      sign-in must be recent: security changes only
 */
function authRouter({
  controller, settings, passwords, requireSignedIn, requireSignedInOrEnrolment, recent, rateLimiter, admission,
}) {
  const router = express.Router();
  const requireAccount = [requireSignedIn, recent];
  const requireAccountOrEnrolment = [requireSignedInOrEnrolment, recent];
  // Rate limits (FR-P4) run first, before validation, so malformed floods are limited too.
  const rl = (scope, byAccount) => rateLimiter.limit(scope, { byAccount });
  // Waiting room (FR-P2): only the START of a sign-in needs admission.
  const admit = admission || [];

  router.post('/auth/register', rl('register', true), registerRules, validate, controller.register);
  router.post('/auth/login', rl('login', true), admit, loginRules, validate, controller.login);

  // Second step of sign-in (pre-auth ticket cookie; the ticket has its own attempt limit).
  router.post('/auth/otp', rl('second_factor', false), sixDigitCode(), validate, controller.verifySecondFactor('email', 'code'));
  router.post('/auth/otp/resend', rl('second_factor', false), controller.resendOtp);
  router.post(
    '/auth/totp/verify',
    rl('second_factor', false),
    body().custom((b) => (typeof b.code === 'string') !== (typeof b.backupCode === 'string'))
      .withMessage('Enter an authenticator code or a backup code.'),
    body('code').optional().isString().trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit code.'),
    body('backupCode').optional().isString().trim().isLength({ min: 10, max: 11 }).withMessage('Enter a backup code like XXXXX-XXXXX.'),
    validate,
    controller.verifyTotpOrBackup,
  );

  // Sign-out (FR-P6). An enrolment-only session may sign out too.
  router.post('/auth/logout', requireSignedInOrEnrolment, controller.logout);
  router.post('/auth/logout-all', requireSignedIn, controller.logoutAll);

  // Security settings: session plus a sign-in in the last 10 minutes.
  router.post('/auth/2fa/email/enable', requireAccount, settings.startEmail2fa);
  router.post('/auth/2fa/email/confirm', requireAccount, sixDigitCode(), validate, settings.confirmEmail2fa);
  // TOTP enrolment also accepts the enrolment-only session (admin without TOTP, FR-A13).
  router.post('/auth/totp/enrol', requireAccountOrEnrolment, settings.startTotp);
  router.post('/auth/totp/enrol/confirm', requireAccountOrEnrolment, sixDigitCode(), validate, settings.confirmTotp);
  router.post('/auth/password/change', requireAccount, changeRules, validate, passwords.change);

  // Password recovery (no ticket: the emailed token is the proof).
  router.post('/auth/password/forgot', rl('forgot', true), forgotRules, validate, passwords.forgot);
  router.post('/auth/password/reset', rl('reset', false), resetRules, validate, passwords.reset);
  return router;
}

module.exports = { authRouter, sixDigitCode };
