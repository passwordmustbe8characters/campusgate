'use strict';

const { validationResult } = require('express-validator');

/**
 * Turn express-validator results into a 400 with per-field messages.
 * Submitted values are never echoed back (they may be passwords).
 */
function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const fields = {};
  for (const error of result.array({ onlyFirstError: true })) {
    fields[error.path] = [error.msg];
  }
  return res.status(400).json({ error: 'Please correct the highlighted fields.', fields });
}

module.exports = { validate };
