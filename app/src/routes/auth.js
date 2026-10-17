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

/**
 * @param controller          auth controller (login, second factor)
 * @param settings            security-settings controller (account ticket only)
 * @param requireAccount      the ONE middleware that accepts the interim account ticket
 */
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

function authRouter({ controller, settings, passwords, requireAccount }) {
  const router = express.Router();
  router.post('/auth/register', registerRules, validate, controller.register);
  router.post('/auth/login', loginRules, validate, controller.login);

  // Second step of sign-in (pre-auth ticket cookie).
  router.post('/auth/otp', sixDigitCode(), validate, controller.verifySecondFactor('email', 'code'));
  router.post('/auth/otp/resend', controller.resendOtp);
  router.post(
    '/auth/totp/verify',
    body().custom((b) => (typeof b.code === 'string') !== (typeof b.backupCode === 'string'))
      .withMessage('Enter an authenticator code or a backup code.'),
    body('code').optional().isString().trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit code.'),
    body('backupCode').optional().isString().trim().isLength({ min: 10, max: 11 }).withMessage('Enter a backup code like XXXXX-XXXXX.'),
    validate,
    controller.verifyTotpOrBackup,
  );

  // Security settings: interim account ticket required (see ACCOUNT_TICKET_ROUTES).
  router.post('/auth/2fa/email/enable', requireAccount, settings.startEmail2fa);
  router.post('/auth/2fa/email/confirm', requireAccount, sixDigitCode(), validate, settings.confirmEmail2fa);
  router.post('/auth/totp/enrol', requireAccount, settings.startTotp);
  router.post('/auth/totp/enrol/confirm', requireAccount, sixDigitCode(), validate, settings.confirmTotp);
  router.post('/auth/password/change', requireAccount, changeRules, validate, passwords.change);

  // Password recovery (no ticket: the emailed token is the proof).
  router.post('/auth/password/forgot', forgotRules, validate, passwords.forgot);
  router.post('/auth/password/reset', resetRules, validate, passwords.reset);
  return router;
}

module.exports = { authRouter, sixDigitCode };
