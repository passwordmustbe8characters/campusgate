'use strict';

/** Matric / staff IDs are stored trimmed and upper-cased. */
const normalizeId = (value) => String(value).trim().toUpperCase();

/** Emails are stored trimmed and lower-cased. */
const normalizeEmail = (value) => String(value).trim().toLowerCase();

const looksLikeEmail = (value) => String(value).includes('@');

module.exports = { normalizeId, normalizeEmail, looksLikeEmail };
