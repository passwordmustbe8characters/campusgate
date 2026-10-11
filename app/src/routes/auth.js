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

function authRouter(controller) {
  const router = express.Router();
  router.post('/auth/register', registerRules, validate, controller.register);
  router.post('/auth/login', loginRules, validate, controller.login);
  return router;
}

module.exports = { authRouter };
