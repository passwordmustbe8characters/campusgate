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
const { VoucherError, VOUCHER_SERVICES } = require('../services/vouchers');
const { SimulatorError } = require('../services/simulator');

const ROLES = ['student', 'staff', 'guest', 'admin'];
const WINDOW_SERVICES = ['fees', 'hostel', 'course_registration'];
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
  const { audit, sessions, preauthTickets, dashboard, accessWindows, vouchers, simulator } = services;
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

  // ---- Simulate rush hour (FR-P8) ----
  router.post('/admin/simulate', ...change, async (req, res) => {
    const ctx = ctxOf(req);
    try {
      const run = await simulator.start({ users: Number(req.body.users), rampSec: Number(req.body.rampSec), actor: ctx.actor });
      await audit.record('rush_hour_simulated', { success: true, details: { actor: ctx.actor, users: run.users, rampSec: run.rampSec } }, ctx);
      return res.status(202).json({ message: `Started: ${run.users} virtual students arriving over ${run.rampSec} s. Watch the figures above.` });
    } catch (err) {
      if (err instanceof SimulatorError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.get('/admin/simulate/status', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await simulator.status());
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

  // ---- Access windows (FR-Z2, FR-D4) ----
  router.get('/admin/windows', csrf.ensurePreSession, ...admin, async (req, res) => {
    const rows = await db('access_windows').join('services', 'services.id', 'access_windows.service_id')
      .orderBy(['services.key', 'on_date', 'start_time'])
      .select('access_windows.id', 'services.key as service', 'level', 'faculty',
        db.raw("to_char(on_date, 'YYYY-MM-DD') AS on_date"), db.raw("to_char(start_time, 'HH24:MI') AS start_time"),
        db.raw("to_char(end_time, 'HH24:MI') AS end_time"));
    const faculties = (await db('student_records').distinct('faculty').orderBy('faculty')).map((r) => r.faculty);
    page('admin-windows', 'Access windows', req, res, { rows, faculties, services: WINDOW_SERVICES });
  });

  router.post('/admin/windows', ...change, async (req, res) => {
    const b = req.body;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!WINDOW_SERVICES.includes(b.service)) return res.status(400).json({ error: 'Choose a service.' });
    if (!time.test(b.start_time || '') || !time.test(b.end_time || '') || b.end_time <= b.start_time) {
      return res.status(400).json({ error: 'Give a start and end time (HH:MM), with the end after the start.' });
    }
    const level = b.level ? Number(b.level) : null;
    if (level !== null && ![100, 200, 300, 400, 500, 600].includes(level)) return res.status(400).json({ error: 'Choose a valid level.' });
    const onDate = b.on_date && /^\d{4}-\d{2}-\d{2}$/.test(b.on_date) ? b.on_date : null;
    const faculty = typeof b.faculty === 'string' && b.faculty.trim() ? b.faculty.trim().slice(0, 80) : null;
    const ctx = ctxOf(req);
    await db.transaction(async (trx) => {
      const service = await trx('services').where({ key: b.service }).first('id');
      await trx('access_windows').insert({
        service_id: service.id, level, faculty, on_date: onDate, start_time: b.start_time, end_time: b.end_time, created_by: req.account.userId,
      });
      await audit.recordCritical(trx, 'window_changed', { success: true, details: { actor: ctx.actor, action: 'add', service: b.service } }, ctx);
    });
    await accessWindows.announceChange();
    return res.status(201).json({ message: `Window added: ${b.service}, ${level ? `${level} level` : 'all levels'}${faculty ? `, ${faculty}` : ''}, ${b.start_time}-${b.end_time}${onDate ? ` on ${onDate}` : ' every day'}.` });
  });

  router.post('/admin/windows/delete', ...change, async (req, res) => {
    const id = Number(req.body.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Unknown window.' });
    const ctx = ctxOf(req);
    const removed = await db.transaction(async (trx) => {
      const row = await trx('access_windows').join('services', 'services.id', 'access_windows.service_id')
        .where('access_windows.id', id).first('services.key as service');
      if (!row) return null;
      await trx('access_windows').where({ id }).del();
      await audit.recordCritical(trx, 'window_changed', { success: true, details: { actor: ctx.actor, action: 'remove', service: row.service } }, ctx);
      return row;
    });
    if (!removed) return res.status(404).json({ error: 'Unknown window.' });
    await accessWindows.announceChange();
    return res.json({ message: 'Window removed.' });
  });

  // ---- Guest vouchers (FR-Z4, FR-D4) ----
  router.get('/admin/vouchers', csrf.ensurePreSession, ...admin, async (req, res) => {
    page('admin-vouchers', 'Guest vouchers', req, res, { rows: await vouchers.list(), services: VOUCHER_SERVICES });
  });

  router.post('/admin/vouchers', ...change, async (req, res) => {
    const services = VOUCHER_SERVICES.filter((s) => req.body[`svc_${s}`] === true || req.body[`svc_${s}`] === 'true');
    try {
      const v = await vouchers.create({ services, hours: req.body.hours, label: req.body.label }, { ...ctxOf(req), adminId: req.account.userId });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({
        message: `Voucher code: ${v.code} (give it to the guest now; it will not be shown again). Valid until ${v.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC, once, for: ${v.services.join(', ')}.`,
        code: v.code,
      });
    } catch (err) {
      if (err instanceof VoucherError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  router.post('/admin/vouchers/revoke', ...change, async (req, res) => {
    const ok = await vouchers.revoke(Number(req.body.id), ctxOf(req));
    return ok ? res.json({ message: 'Voucher cancelled; any guest session from it has ended.' }) : res.status(404).json({ error: 'No such active voucher.' });
  });

  // ---- Suspicious activity (FR-D5), from the audit log ----
  router.get('/admin/suspicious', csrf.ensurePreSession, ...admin, async (req, res) => {
    const lastHour = db.raw("now() - interval '60 minutes'");
    const [accounts, ips, lockouts, risk] = await Promise.all([
      // Repeated failures on one account (known accounts by ID; unknown ones by the keyed hash of what was typed).
      db('auth_logs').leftJoin('users', 'users.id', 'auth_logs.user_id')
        .where('event_type', 'login_failure').where('occurred_at', '>', lastHour)
        .groupBy('users.matric_or_staff_id', 'auth_logs.subject_hash')
        .havingRaw('count(*) >= 3')
        .select('users.matric_or_staff_id as account', 'auth_logs.subject_hash',
          db.raw('count(*)::int AS failures'), db.raw('count(DISTINCT ip)::int AS ips'), db.raw('max(occurred_at) AS last'))
        .orderBy('failures', 'desc').limit(50),
      // Bursts from one address, and how many different accounts it tried (password spraying).
      db('auth_logs').where('event_type', 'login_failure').where('occurred_at', '>', lastHour)
        .groupBy('ip').havingRaw('count(*) >= 5')
        .select('ip', db.raw('count(*)::int AS failures'),
          db.raw('count(DISTINCT coalesce(user_id::text, subject_hash))::int AS accounts'), db.raw('max(occurred_at) AS last'))
        .orderBy('failures', 'desc').limit(50),
      db('auth_logs').leftJoin('users', 'users.id', 'auth_logs.user_id').where('event_type', 'lockout')
        .where('occurred_at', '>', db.raw("now() - interval '24 hours'"))
        .orderBy('seq', 'desc').limit(20).select('users.matric_or_staff_id as account', 'auth_logs.ip', 'auth_logs.occurred_at'),
      db('auth_logs').where('occurred_at', '>', db.raw("now() - interval '24 hours'"))
        .where((w) => w.whereRaw("event_type = 'login_failure' AND details->>'reason' = 'risk_blocked'")
          .orWhereRaw("event_type = 'second_factor_required' AND details->>'reason' = 'risk'"))
        .select(db.raw("count(*) FILTER (WHERE event_type = 'login_failure')::int AS blocked"),
          db.raw("count(*) FILTER (WHERE event_type = 'second_factor_required')::int AS stepped_up")).first(),
    ]);
    page('admin-suspicious', 'Suspicious activity', req, res, { accounts, ips, lockouts, risk });
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
