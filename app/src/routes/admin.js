'use strict';

const express = require('express');
const { auditContext } = require('../audit/audit');
const { verifyChain, readAnchor } = require('../audit/chain');
const { resolveFilters, applyFilters, iterateRows, describeFilters } = require('../audit/query');
const { csvRow, EXPORT_COLUMNS } = require('../audit/csv');
const { EVENT_TYPES } = require('../audit/events');
const { requireAdmin2FA } = require('../middleware/requireAdmin2FA');
const { requirePermission } = require('../policies/permissions');
const { getPolicy } = require('../policies/policyRepo');
const { normalizeId, normalizeEmail, looksLikeEmail } = require('../services/identity');
const { unlockUser, resetTwoFactor, setUserActive, searchUsers, listLockedUsers } = require('../services/userService');
const { setPolicy, setRole, policyHistory, AdminChangeError, POLICY_FIELDS } = require('../services/adminChangeService');

const ROLES = ['student', 'staff', 'guest', 'admin'];
const DASHBOARD_EVERY_MS = 2000;

/** Log filters from a query string, validated (bad values are ignored, never passed to SQL as text). */
function logFilters(q) {
  const f = {};
  if (typeof q.type === 'string' && EVENT_TYPES[q.type]) f.type = q.type;
  if (typeof q.user === 'string' && q.user.trim() !== '' && q.user.length <= 254) f.user = q.user.trim();
  if (q.success === 'true' || q.success === 'false') f.success = q.success === 'true';
  if (typeof q.ip === 'string' && /^[0-9a-fA-F:.]{1,64}$/.test(q.ip)) f.ip = q.ip;
  for (const d of ['from', 'to']) if (typeof q[d] === 'string' && q[d] && !Number.isNaN(Date.parse(q[d]))) f[d] = q[d];
  return f;
}

/**
 * Admin console (FR-D1 to D3, FR-Z5, FR-L3, FR-L4, FR-A6).
 * Every route: session + admin role with an authenticator app (FR-A13) +
 * the admin_console permission. Every change: CSRF + a sign-in from the last
 * 10 minutes, and is audited fail closed with actor "admin:<user id>".
 */
function adminRouter({ db, redis, config, csrf, requireSignedIn, recent, permissions, services }) {
  const router = express.Router();
  const { audit, sessions, preauthTickets, waitingRoom, dashboard } = services;
  const admin = [requireSignedIn, requireAdmin2FA({ db }), requirePermission(permissions, 'admin_console')];
  const change = [...admin, recent];
  const ctxOf = (req) => ({ ...auditContext(req), actor: `admin:${req.account.userId}` });
  const page = (name, title, req, res, data = {}) =>
    res.render(name, { title, csrfToken: csrf.generateCsrfToken(req, res), account: req.account, ...data });
  const fail = (res, err) => {
    if (err instanceof AdminChangeError) return res.status(400).json({ error: err.message });
    throw err;
  };

  /** Sign a user out everywhere after a role change, 2FA reset or deactivation. */
  async function revokeAccess(userId, reason, ctx) {
    await preauthTickets.revokeUser(userId);
    const count = await sessions.revokeUser(userId, reason);
    await audit.record('sessions_revoked', { userId, success: true, details: { reason, count, actor: ctx.actor } }, ctx);
    return count;
  }

  // ---- Dashboard (FR-D1) ----
  router.get('/admin', csrf.ensurePreSession, ...admin, async (req, res) => {
    page('admin-dashboard', 'Admin dashboard', req, res, { snapshot: await dashboard.snapshot() });
  });

  // Server-sent events: one snapshot every 2 s while the page is open.
  router.get('/admin/metrics/stream', ...admin, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    let open = true;
    const send = async () => {
      if (!open) return;
      try {
        res.write(`data: ${JSON.stringify(await dashboard.snapshot())}\n\n`);
      } catch (err) {
        req.log.warn({ event: 'dashboard_snapshot_failed', err }, 'dashboard snapshot failed');
        res.write('event: unavailable\ndata: {}\n\n');
      }
    };
    send();
    const timer = setInterval(send, DASHBOARD_EVERY_MS);
    req.on('close', () => {
      open = false;
      clearInterval(timer);
    });
  });

  // ---- Users (FR-D2, FR-A6) ----
  router.get('/admin/users', csrf.ensurePreSession, ...admin, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 254) : '';
    const [users, locked] = await Promise.all([q ? searchUsers(db, q) : [], listLockedUsers(db)]);
    page('admin-users', 'Users', req, res, { q, users, locked, roles: ROLES });
  });

  const identifierOf = (req) => (typeof req.body.identifier === 'string' ? req.body.identifier.trim().slice(0, 254) : '');
  // Admins may not lock themselves out (deactivate themselves or drop their own admin role).
  async function isSelf(req, identifier) {
    const where = looksLikeEmail(identifier) ? { email: normalizeEmail(identifier) } : { matric_or_staff_id: normalizeId(identifier) };
    const row = await db('users').where(where).first('id');
    return Boolean(row) && Number(row.id) === Number(req.account.userId);
  }
  const notFound = (res, id) => res.status(404).json({ error: `No user found for "${id}".` });

  router.post('/admin/users/unlock', ...change, async (req, res) => {
    const id = identifierOf(req);
    const row = await unlockUser(db, id, { audit, ctx: ctxOf(req) });
    if (!row) return notFound(res, id);
    return res.json({ message: `Unlocked ${row.matric_or_staff_id}.` });
  });

  router.post('/admin/users/reset-2fa', ...change, async (req, res) => {
    const id = identifierOf(req);
    const ctx = ctxOf(req);
    const row = await resetTwoFactor(db, id, { audit, ctx });
    if (!row) return notFound(res, id);
    const count = await revokeAccess(row.id, 'two_factor_reset', ctx);
    return res.json({ message: `Two-step sign-in reset for ${row.matric_or_staff_id} (${count} session(s) ended).` });
  });

  router.post('/admin/users/status', ...change, async (req, res) => {
    const id = identifierOf(req);
    const active = req.body.active === true || req.body.active === 'true';
    if (!active && (await isSelf(req, id))) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    const ctx = ctxOf(req);
    const row = await setUserActive(db, id, active, { audit, ctx });
    if (!row) return notFound(res, id);
    const count = active ? 0 : await revokeAccess(row.id, 'deactivated', ctx);
    return res.json({ message: `${row.matric_or_staff_id} is now ${active ? 'active' : `inactive (${count} session(s) ended)`}.` });
  });

  router.post('/admin/users/role', ...change, async (req, res) => {
    const id = identifierOf(req);
    if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Choose a valid role.' });
    if (req.body.role !== 'admin' && (await isSelf(req, id))) return res.status(400).json({ error: 'You cannot remove your own admin role.' });
    const ctx = ctxOf(req);
    let result;
    try {
      result = await setRole(db, audit, id, req.body.role, ctx);
    } catch (err) {
      return fail(res, err);
    }
    if (!result.changed) return res.json({ message: `No change: ${result.user.matric_or_staff_id} already has role ${result.to}.` });
    const count = await revokeAccess(result.user.id, 'role_changed', ctx);
    return res.json({ message: `Role of ${result.user.matric_or_staff_id} changed: ${result.from} -> ${result.to} (${count} session(s) ended).` });
  });

  // ---- Policies (FR-D3, FR-Z5) ----
  router.get('/admin/policies', csrf.ensurePreSession, ...admin, async (req, res) => {
    const [policy, history] = await Promise.all([getPolicy(db), policyHistory(db, { limit: 30 })]);
    page('admin-policies', 'Policies', req, res, { policy, history, fields: Object.keys(POLICY_FIELDS) });
  });

  router.post('/admin/policies', ...change, async (req, res) => {
    // Only fields that are present AND different from the current value become changes.
    const current = await getPolicy(db);
    const pairs = Object.keys(POLICY_FIELDS)
      .filter((k) => req.body[k] !== undefined && req.body[k] !== '' && String(req.body[k]) !== String(current[k]))
      .map((k) => `${k}=${req.body[k]}`);
    if (pairs.length === 0) return res.json({ message: 'No change.' });
    let result;
    try {
      result = await setPolicy(db, audit, pairs, ctxOf(req));
    } catch (err) {
      return fail(res, err);
    }
    const summary = result.changed.map((k) => `${k} ${result.before[k]} -> ${result.after[k]}`).join(', ');
    return res.json({ message: `Policy changed: ${summary}. It applies to the next request (no restart).` });
  });

  // ---- Audit log (FR-L3, FR-L4) ----
  router.get('/admin/logs', csrf.ensurePreSession, ...admin, async (req, res) => {
    const filters = logFilters(req.query);
    const resolved = await resolveFilters(db, filters);
    const rows = await applyFilters(db('auth_logs'), resolved).orderBy('seq', 'desc').limit(100);
    page('admin-logs', 'Audit log', req, res, { rows, filters, query: req.query, eventTypes: Object.keys(EVENT_TYPES).sort() });
  });

  router.get('/admin/logs/export', ...admin, recent, async (req, res) => {
    const filters = logFilters(req.query);
    const resolved = await resolveFilters(db, filters);
    const { n } = await applyFilters(db('auth_logs'), resolved).count({ n: '*' }).first();
    // Fail closed: if the export cannot be recorded, nothing is sent.
    await audit.withCritical('audit_exported', {
      success: true, details: { actor: `admin:${req.account.userId}`, rows: Number(n), filters: describeFilters(filters) },
    }, ctxOf(req), async () => null);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"', 'Cache-Control': 'no-store' });
    res.write(csvRow(EXPORT_COLUMNS));
    for await (const row of iterateRows(db, filters)) res.write(csvRow(EXPORT_COLUMNS.map((c) => row[c])));
    res.end();
  });

  router.post('/admin/logs/verify', ...change, async (req, res) => {
    const started = process.hrtime.bigint();
    const anchor = await readAnchor(redis).catch(() => null);
    const result = await verifyChain(db, config.auditHmacKey, { anchor });
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    await audit.withCritical('audit_verified', {
      success: true, details: { actor: `admin:${req.account.userId}`, ok: result.ok, checked: result.checked, reason: result.reason || 'none' },
    }, ctxOf(req), async () => null);
    const message = result.ok
      ? `OK: the chain is intact (${result.checked} rows checked in ${ms} ms).`
      : `BROKEN at seq ${result.firstBadSeq}: ${result.reason} (${result.detail}).`;
    return res.json({ ok: result.ok, message, checked: result.checked, firstBadSeq: result.firstBadSeq, reason: result.reason });
  });

  return router;
}

module.exports = { adminRouter, logFilters };
