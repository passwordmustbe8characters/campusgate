'use strict';

/**
 * CSV output for audit exports (FR-L4), RFC 4180 quoting plus protection
 * against CSV formula injection: a cell that starts with = + - @ (or a tab
 * or carriage return) is prefixed with a single quote, so a spreadsheet shows
 * it as text instead of running it. This matters here because some cells
 * come from attackers (the user agent of a failed login, for example).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvRow = (values) => `${values.map(csvCell).join(',')}\r\n`;

const EXPORT_COLUMNS = Object.freeze([
  'seq', 'occurred_at', 'event_type', 'success', 'user_id', 'subject_hash', 'ip', 'user_agent', 'details', 'row_hash',
]);

module.exports = { csvCell, csvRow, EXPORT_COLUMNS };
