'use strict';

const { normalizeId, normalizeEmail, looksLikeEmail } = require('../services/identity');

/**
 * Search filters for the audit log (FR-L4), shared by `search` and `export`.
 * filters: { type, user (matric/staff ID or email), from, to (ISO dates), success, ip }
 *
 * resolveFilters() is async (looks the user up); applyFilters() is deliberately
 * synchronous: a knex query builder is "thenable", so returning one from an
 * async function would run the query instead of returning the builder.
 */
async function resolveFilters(db, filters = {}) {
  const resolved = { ...filters };
  if (filters.user) {
    const where = looksLikeEmail(filters.user) ? { email: normalizeEmail(filters.user) } : { matric_or_staff_id: normalizeId(filters.user) };
    const user = await db('users').where(where).first('id');
    resolved.userId = user ? user.id : -1; // unknown user -> no rows
  }
  return resolved;
}

function applyFilters(query, resolved) {
  let q = query;
  if (resolved.type) q = q.where('event_type', resolved.type);
  if (resolved.success !== undefined) q = q.where('success', resolved.success);
  if (resolved.ip) q = q.where('ip', resolved.ip);
  if (resolved.from) q = q.where('occurred_at', '>=', new Date(resolved.from));
  if (resolved.to) q = q.where('occurred_at', '<', new Date(resolved.to));
  if (resolved.userId !== undefined) q = q.where('user_id', resolved.userId);
  return q;
}

/** Page through matching rows in seq order (keyset paging: constant memory). */
async function* iterateRows(db, filters, { pageSize = 2000 } = {}) {
  const resolved = await resolveFilters(db, filters);
  let after = 0;
  for (;;) {
    const page = await applyFilters(db('auth_logs').where('seq', '>', after), resolved).orderBy('seq').limit(pageSize);
    if (page.length === 0) return;
    for (const row of page) yield row;
    after = Number(page[page.length - 1].seq);
  }
}

/** Short, audit-safe description of the filters used (for the audit_exported event). */
function describeFilters(filters) {
  const parts = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (k === 'user' ? 'user=given' : `${k}=${String(v).replace(/[^A-Za-z0-9_.:+\-]/g, '')}`));
  return parts.length ? parts.join(' ').slice(0, 120) : 'none';
}

module.exports = { resolveFilters, applyFilters, iterateRows, describeFilters };
